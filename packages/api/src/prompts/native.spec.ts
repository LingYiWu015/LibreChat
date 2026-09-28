import type {
  PromptRecord,
  PromptGroupRecord,
  PromptCreationResult,
  CreatePromptGroupInput,
  AddPromptRevisionInput,
} from './types';
import type { NativePromptDependencies } from './native';
import { createNativePromptAdapter, selectionUnavailableReason } from './native';

const revision = (overrides: Partial<PromptRecord> = {}): PromptRecord => ({
  _id: 'prompt-1',
  groupId: 'group-1',
  author: 'user-1',
  prompt: 'Native prompt',
  type: 'text',
  ...overrides,
});

const group = (overrides: Partial<PromptGroupRecord> = {}): PromptGroupRecord => ({
  _id: 'group-1',
  name: 'Native group',
  author: 'user-1',
  authorName: 'User',
  productionId: 'prompt-1',
  productionPrompt: revision(),
  ...overrides,
});

function createDependencies(): jest.Mocked<NativePromptDependencies> {
  return {
    getPromptGroup: jest.fn().mockResolvedValue(group()),
    getPrompt: jest.fn().mockResolvedValue(revision()),
    getPrompts: jest.fn().mockResolvedValue([revision()]),
    createPromptGroup: jest.fn().mockResolvedValue({
      group: group(),
      prompt: revision(),
    } satisfies PromptCreationResult),
    savePrompt: jest.fn().mockResolvedValue({ prompt: revision() }),
    makePromptProduction: jest
      .fn()
      .mockResolvedValue({ message: 'Prompt production made successfully' }),
    deletePrompt: jest.fn().mockResolvedValue({ prompt: 'Prompt deleted successfully' }),
  };
}

describe('createNativePromptAdapter', () => {
  it('resolves Production from a sufficient loaded group without another read', async () => {
    const dependencies = createDependencies();
    const adapter = createNativePromptAdapter(dependencies);

    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'production' },
        loadedGroup: group(),
      }),
    ).resolves.toEqual({
      groupId: 'group-1',
      promptId: 'prompt-1',
      prompt: 'Native prompt',
      type: 'text',
    });
    expect(dependencies.getPromptGroup).not.toHaveBeenCalled();
    expect(dependencies.getPrompt).not.toHaveBeenCalled();
  });

  it('honors loaded missing records without another read', async () => {
    const dependencies = createDependencies();
    const adapter = createNativePromptAdapter(dependencies);

    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'production' },
        loadedGroup: null,
      }),
    ).resolves.toBeNull();
    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'exact', promptId: 'prompt-1' },
        loadedRevision: null,
      }),
    ).resolves.toBeNull();
    expect(dependencies.getPromptGroup).not.toHaveBeenCalled();
    expect(dependencies.getPrompt).not.toHaveBeenCalled();
  });

  it('loads the Production revision when the group snapshot is only a projection', async () => {
    const dependencies = createDependencies();
    const adapter = createNativePromptAdapter(dependencies);

    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'production' },
        loadedGroup: group({ productionPrompt: null }),
      }),
    ).resolves.toEqual(expect.objectContaining({ promptId: 'prompt-1' }));
    expect(dependencies.getPrompt).toHaveBeenCalledWith('prompt-1');
  });

  it.each([
    ['missing group', null],
    ['missing Production', group({ productionId: null, productionPrompt: null })],
  ])('returns null for %s', async (_case, loadedGroup) => {
    const dependencies = createDependencies();
    dependencies.getPromptGroup.mockResolvedValue(loadedGroup);
    const adapter = createNativePromptAdapter(dependencies);

    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'production' },
      }),
    ).resolves.toBeNull();
  });

  it('resolves an exact loaded revision without another read', async () => {
    const dependencies = createDependencies();
    const adapter = createNativePromptAdapter(dependencies);

    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'exact', promptId: 'prompt-1' },
        loadedRevision: revision(),
      }),
    ).resolves.toEqual(expect.objectContaining({ promptId: 'prompt-1' }));
    expect(dependencies.getPrompt).not.toHaveBeenCalled();
  });

  it('rejects an exact revision from another group', async () => {
    const dependencies = createDependencies();
    dependencies.getPrompt.mockResolvedValue(revision({ groupId: 'group-2' }));
    const adapter = createNativePromptAdapter(dependencies);

    await expect(
      adapter.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'exact', promptId: 'prompt-1' },
      }),
    ).resolves.toBeNull();
  });

  it('does not trust a mismatched loaded exact revision', async () => {
    const dependencies = createDependencies();
    const adapter = createNativePromptAdapter(dependencies);

    await adapter.resolvePrompt({
      groupId: 'group-1',
      selection: { type: 'exact', promptId: 'prompt-1' },
      loadedRevision: revision({ _id: 'prompt-2' }),
    });

    expect(dependencies.getPrompt).toHaveBeenCalledWith('prompt-1');
  });

  it('delegates native reads and mutations one to one', async () => {
    const dependencies = createDependencies();
    const adapter = createNativePromptAdapter(dependencies);
    const createInput: CreatePromptGroupInput = {
      group: { name: 'Native group' },
      prompt: { prompt: 'Native prompt', type: 'text' },
      author: 'user-1',
      authorName: 'User',
    };
    const addInput: AddPromptRevisionInput = {
      groupId: 'group-1',
      prompt: { prompt: 'Revision', type: 'chat' },
      author: 'user-1',
    };

    await adapter.getGroup('group-1');
    await adapter.getRevision('prompt-1');
    await adapter.listRevisions('group-1');
    await adapter.createGroup(createInput);
    await adapter.addRevision(addInput);
    await adapter.promoteRevision('prompt-1');
    await adapter.deleteRevision({ groupId: 'group-1', promptId: 'prompt-1' });

    expect(dependencies.getPromptGroup).toHaveBeenCalledWith('group-1');
    expect(dependencies.getPrompt).toHaveBeenCalledWith('prompt-1');
    expect(dependencies.getPrompts).toHaveBeenCalledWith('group-1');
    expect(dependencies.createPromptGroup).toHaveBeenCalledWith(createInput);
    expect(dependencies.savePrompt).toHaveBeenCalledWith(addInput);
    expect(dependencies.makePromptProduction).toHaveBeenCalledWith('prompt-1');
    expect(dependencies.deletePrompt).toHaveBeenCalledWith({
      groupId: 'group-1',
      promptId: 'prompt-1',
    });
  });

  it('throws when native promotion reports a failure', async () => {
    const dependencies = createDependencies();
    dependencies.makePromptProduction.mockResolvedValue({
      message: 'Error making prompt production',
    });
    const adapter = createNativePromptAdapter(dependencies);

    await expect(adapter.promoteRevision('prompt-1')).rejects.toThrow(
      'Error making prompt production',
    );
  });

  it('maps selection kinds to stable unavailable reasons', () => {
    expect(selectionUnavailableReason({ type: 'production' })).toBe('production');
    expect(selectionUnavailableReason({ type: 'exact', promptId: 'prompt-1' })).toBe('revision');
  });
});
