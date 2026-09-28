import type { FiltersConfig } from 'librechat-data-provider';
import type {
  PromptStore,
  PromptRecord,
  PromptListInput,
  PromptGroupRecord,
  PromptSourceAdapter,
  PromptServiceDependencies,
} from './types';
import { createPromptService } from './service';

const filters: FiltersConfig = {
  prompts: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
};

const revision = (overrides: Partial<PromptRecord> = {}): PromptRecord => ({
  _id: 'prompt-1',
  groupId: 'group-1',
  author: 'user-1',
  prompt: 'Safe prompt',
  type: 'text',
  ...overrides,
});

const group = (overrides: Partial<PromptGroupRecord> = {}): PromptGroupRecord => ({
  _id: 'group-1',
  name: 'Safe group',
  author: 'user-1',
  authorName: 'User',
  productionId: 'prompt-1',
  productionPrompt: revision(),
  ...overrides,
});

const listInput = (overrides: Partial<PromptListInput> = {}): PromptListInput => ({
  accessibleIds: ['group-1'],
  publiclyAccessibleIds: [],
  ownedPromptGroupIds: ['group-1'],
  limit: 20,
  after: null,
  forReuse: false,
  ...overrides,
});

function createDependencies(): {
  dependencies: PromptServiceDependencies;
  source: jest.Mocked<PromptSourceAdapter>;
  store: jest.Mocked<PromptStore>;
  grantCreatorOwnership: jest.MockedFunction<PromptServiceDependencies['grantCreatorOwnership']>;
  logger: PromptServiceDependencies['logger'] & { error: jest.Mock };
} {
  const source: jest.Mocked<PromptSourceAdapter> = {
    resolvePrompt: jest.fn().mockResolvedValue({
      groupId: 'group-1',
      promptId: 'prompt-1',
      prompt: 'Safe prompt',
      type: 'text',
    }),
    getGroup: jest.fn().mockResolvedValue(group()),
    getRevision: jest.fn().mockResolvedValue(revision()),
    listRevisions: jest.fn().mockResolvedValue([revision()]),
    createGroup: jest.fn().mockResolvedValue({ group: group(), prompt: revision() }),
    addRevision: jest.fn().mockResolvedValue({ prompt: revision() }),
    promoteRevision: jest
      .fn()
      .mockResolvedValue({ message: 'Prompt production made successfully' }),
    deleteRevision: jest.fn().mockResolvedValue({ prompt: 'Prompt deleted successfully' }),
  };
  const store: jest.Mocked<PromptStore> = {
    listGroups: jest.fn().mockResolvedValue({
      data: [group()],
      has_more: false,
      after: null,
    }),
    updateGroup: jest.fn().mockResolvedValue(group()),
    incrementUsage: jest.fn().mockResolvedValue({ numberOfGenerations: 2 }),
    deleteGroup: jest.fn().mockResolvedValue({ message: 'Prompt group deleted successfully' }),
    deleteUserPrompts: jest.fn().mockResolvedValue(undefined),
  };
  const grantCreatorOwnership = jest.fn().mockResolvedValue(undefined);
  const logger = { error: jest.fn() };
  return {
    source,
    store,
    grantCreatorOwnership,
    logger,
    dependencies: { source, store, grantCreatorOwnership, logger },
  };
}

describe('createPromptService', () => {
  it('returns a safe selected revision', async () => {
    const { dependencies } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'production' },
        filters,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        groupId: 'group-1',
        promptId: 'prompt-1',
        prompt: 'Safe prompt',
        type: 'text',
      },
    });
  });

  it('rejects blocked selected content without inspecting group metadata', async () => {
    const { dependencies, source } = createDependencies();
    source.resolvePrompt.mockResolvedValue({
      groupId: 'group-1',
      promptId: 'prompt-1',
      prompt: 'PRIVATE-PROMPT',
      type: 'text',
    });
    const service = createPromptService(dependencies);

    const result = await service.resolvePrompt({
      groupId: 'group-1',
      selection: { type: 'exact', promptId: 'prompt-1' },
      loadedGroup: group({ name: 'PRIVATE-GROUP' }),
      filters,
    });

    expect(result).toMatchObject({ ok: false, error: { type: 'blocked_content' } });
  });

  it('returns an unavailable result for a missing selection', async () => {
    const { dependencies, source } = createDependencies();
    source.resolvePrompt.mockResolvedValue(null);
    const service = createPromptService(dependencies);

    await expect(
      service.resolvePrompt({
        groupId: 'group-1',
        selection: { type: 'exact', promptId: 'missing' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'revision' },
    });
  });

  it('projects catalog content while retaining database cursor progression', async () => {
    const { dependencies, store } = createDependencies();
    store.listGroups.mockResolvedValue({
      data: [
        group(),
        group({
          _id: 'group-2',
          name: 'Safe group 2',
          productionId: 'prompt-2',
          productionPrompt: revision({
            _id: 'prompt-2',
            groupId: 'group-2',
            prompt: 'PRIVATE-PROMPT',
          }),
        }),
      ],
      has_more: true,
      after: 'database-cursor',
    });
    const service = createPromptService(dependencies);

    const result = await service.listGroups(
      listInput({
        publiclyAccessibleIds: ['group-1'],
        forReuse: true,
        filters,
      }),
    );

    expect(result).toEqual({
      data: [expect.objectContaining({ _id: 'group-1', isPublic: true })],
      has_more: true,
      after: 'database-cursor',
    });
  });

  it('passes only business listing inputs to the store', async () => {
    const { dependencies, store } = createDependencies();
    const service = createPromptService(dependencies);

    await service.listGroups(listInput({ filters, forReuse: true }));

    expect(store.listGroups).toHaveBeenCalledWith({
      accessibleIds: ['group-1'],
      publiclyAccessibleIds: [],
      ownedPromptGroupIds: ['group-1'],
      limit: 20,
      after: null,
    });
  });

  it('redacts blocked revision history while preserving structural fields', async () => {
    const { dependencies, source } = createDependencies();
    source.listRevisions.mockResolvedValue([revision({ prompt: 'PRIVATE-PROMPT' })]);
    const service = createPromptService(dependencies);

    await expect(service.listRevisions({ groupId: 'group-1', filters })).resolves.toEqual([
      expect.objectContaining({ _id: 'prompt-1', prompt: '', contentFilterBlocked: true }),
    ]);
  });

  it('rejects creation without a group name before writing', async () => {
    const input = { group: { name: '' }, prompt: { prompt: 'Safe', type: 'text' as const } };
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    const result = await service.createGroup({
      ...input,
      author: 'user-1',
      authorName: 'User',
    });

    expect(result).toMatchObject({ ok: false, error: { type: 'invalid_input' } });
    expect(source.createGroup).not.toHaveBeenCalled();
  });

  it('rejects invalid group metadata before creating the group', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.createGroup({
        group: { name: 'Group', command: 'UPPER' },
        prompt: { prompt: 'Safe', type: 'text' },
        author: 'user-1',
        authorName: 'User',
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'invalid_input' } });
    expect(source.createGroup).not.toHaveBeenCalled();
  });

  it('rejects an invalid initial prompt before creating its group', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.createGroup({
        group: { name: 'Group' },
        prompt: { prompt: '  ', type: 'text' },
        author: 'user-1',
        authorName: 'User',
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'invalid_input' } });
    await expect(
      service.createGroup({
        group: { name: 'Group' },
        prompt: { prompt: 'Safe', type: 'invalid' as 'text' },
        author: 'user-1',
        authorName: 'User',
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'invalid_input' } });
    expect(source.createGroup).not.toHaveBeenCalled();
  });

  it('rejects protected creation before writing', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    const result = await service.createGroup({
      group: { name: 'PRIVATE-GROUP' },
      prompt: { prompt: 'Safe', type: 'text' },
      author: 'user-1',
      authorName: 'User',
      filters,
    });

    expect(result).toMatchObject({ ok: false, error: { type: 'blocked_content' } });
    expect(source.createGroup).not.toHaveBeenCalled();
  });

  it('creates a group and grants its creator ownership', async () => {
    const { dependencies, source, grantCreatorOwnership } = createDependencies();
    const service = createPromptService(dependencies);
    const input = {
      group: { name: 'Group' },
      prompt: { prompt: 'Safe', type: 'chat' as const },
      author: 'user-1',
      authorName: 'User',
    };

    await expect(service.createGroup(input)).resolves.toMatchObject({ ok: true });
    expect(source.createGroup).toHaveBeenCalledWith(input);
    expect(grantCreatorOwnership).toHaveBeenCalledWith({
      userId: 'user-1',
      groupId: 'group-1',
    });
  });

  it('logs ownership grant failure and still returns creation success', async () => {
    const { dependencies, grantCreatorOwnership, logger } = createDependencies();
    grantCreatorOwnership.mockRejectedValue(new Error('ACL unavailable'));
    const service = createPromptService(dependencies);

    await expect(
      service.createGroup({
        group: { name: 'Group' },
        prompt: { prompt: 'Safe', type: 'text' },
        author: 'user-1',
        authorName: 'User',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to grant creator ownership for prompt group group-1',
      expect.any(Error),
    );
  });

  it('validates and protects a revision before saving it', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);
    const invalid = {
      groupId: 'group-1',
      prompt: { prompt: 'Safe', type: 'invalid' as 'text' },
      author: 'user-1',
    };

    await expect(service.addRevision(invalid)).resolves.toMatchObject({
      ok: false,
      error: { type: 'invalid_input' },
    });
    await expect(
      service.addRevision({
        groupId: 'group-1',
        prompt: { prompt: 'PRIVATE-PROMPT', type: 'text' },
        author: 'user-1',
        filters,
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
    expect(source.addRevision).not.toHaveBeenCalled();
  });

  it('saves a valid revision without promoting it', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);
    const input = {
      groupId: 'group-1',
      prompt: { prompt: 'Safe revision', type: 'chat' as const },
      author: 'user-1',
    };

    await expect(service.addRevision(input)).resolves.toMatchObject({ ok: true });
    expect(source.addRevision).toHaveBeenCalledWith(input);
    expect(source.promoteRevision).not.toHaveBeenCalled();
  });

  it('reuses a full loaded group and preserves Production redaction', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    const result = await service.getGroup({
      groupId: 'group-1',
      loadedGroup: group({
        productionPrompt: revision({ prompt: 'PRIVATE-PROMPT' }),
      }),
      filters,
    });

    expect(source.getGroup).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      value: { productionPrompt: { prompt: '', contentFilterBlocked: true } },
    });
  });

  it('rejects blocked group metadata before projection', async () => {
    const { dependencies } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.getGroup({
        groupId: 'group-1',
        loadedGroup: group({ name: 'PRIVATE-GROUP' }),
        filters,
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
  });

  it('returns null for an absent management record', async () => {
    const { dependencies, source } = createDependencies();
    source.getGroup.mockResolvedValue(null);
    source.getRevision.mockResolvedValue(null);
    const service = createPromptService(dependencies);

    await expect(service.getGroup({ groupId: 'missing' })).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(service.getRevision({ promptId: 'missing' })).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it('reuses a loaded revision and rejects blocked content', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    const result = await service.getRevision({
      promptId: 'prompt-1',
      loadedRevision: revision({ prompt: 'PRIVATE-PROMPT' }),
      filters,
    });

    expect(source.getRevision).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { type: 'blocked_content' } });
  });

  it('validates metadata updates and protects them before writing', async () => {
    const { dependencies, store } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.updateGroup({
        groupId: 'group-1',
        updates: { name: 'PRIVATE-GROUP' },
        filters,
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
    expect(store.updateGroup).not.toHaveBeenCalled();
  });

  it('returns invalid input when a metadata update fails schema validation', async () => {
    const { dependencies, store } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.updateGroup({
        groupId: 'group-1',
        updates: { author: 'user-2' } as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: 'invalid_input' } });
    expect(store.updateGroup).not.toHaveBeenCalled();
  });

  it('stops promotion when the revision is missing or blocked', async () => {
    const { dependencies, source } = createDependencies();
    source.getRevision
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(revision({ prompt: 'PRIVATE-PROMPT' }));
    const service = createPromptService(dependencies);

    await expect(service.promoteRevision({ promptId: 'missing' })).resolves.toEqual({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'revision' },
    });
    await expect(service.promoteRevision({ promptId: 'prompt-1', filters })).resolves.toMatchObject(
      { ok: false, error: { type: 'blocked_content' } },
    );
    expect(source.promoteRevision).not.toHaveBeenCalled();
  });

  it('reuses a loaded revision before promotion', async () => {
    const { dependencies, source } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(
      service.promoteRevision({
        promptId: 'prompt-1',
        loadedRevision: revision(),
        filters,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(source.getRevision).not.toHaveBeenCalled();
    expect(source.promoteRevision).toHaveBeenCalledWith('prompt-1');
  });

  it('exposes usage and deletion as separate operations', async () => {
    const { dependencies, source, store } = createDependencies();
    const service = createPromptService(dependencies);

    await expect(service.incrementUsage('group-1')).resolves.toEqual({
      numberOfGenerations: 2,
    });
    await service.deleteRevision({ groupId: 'group-1', promptId: 'prompt-1' });
    await service.deleteGroup('group-1');
    await service.deleteUserPrompts('user-1');

    expect(source.deleteRevision).toHaveBeenCalledWith({
      groupId: 'group-1',
      promptId: 'prompt-1',
    });
    expect(store.deleteGroup).toHaveBeenCalledWith('group-1');
    expect(store.deleteUserPrompts).toHaveBeenCalledWith('user-1');
  });
});
