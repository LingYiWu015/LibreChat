import type {
  PromptRecord,
  PromptProjection,
  PromptSelection,
  ResolvedPrompt,
  PromptGroupRecord,
  PromptSourceAdapter,
  PromptCreationResult,
  CreatePromptGroupInput,
  AddPromptRevisionInput,
} from './types';

type ResolvablePrompt = Pick<PromptRecord, '_id' | 'groupId' | 'prompt' | 'type'>;

export interface NativePromptDependencies {
  getPromptGroup(groupId: string): Promise<PromptGroupRecord | null>;
  getPrompt(promptId: string): Promise<PromptRecord | null>;
  getPrompts(groupId: string): Promise<readonly PromptRecord[]>;
  createPromptGroup(input: CreatePromptGroupInput): Promise<PromptCreationResult>;
  savePrompt(input: AddPromptRevisionInput): Promise<{ readonly prompt: PromptRecord }>;
  makePromptProduction(promptId: string): Promise<{ readonly message: string }>;
  deletePrompt(input: { readonly groupId: string; readonly promptId: string }): Promise<{
    readonly prompt: string;
    readonly promptGroup?: { readonly message: string; readonly id: string };
  }>;
}

function isMatchingRevision(
  revision: PromptRecord | PromptProjection | null | undefined,
  groupId: string,
  promptId?: string,
): revision is ResolvablePrompt {
  return (
    revision != null &&
    revision.groupId === groupId &&
    revision.type != null &&
    (promptId == null || revision._id === promptId)
  );
}

function resolveValue(revision: ResolvablePrompt): ResolvedPrompt {
  return {
    groupId: revision.groupId,
    promptId: revision._id,
    prompt: revision.prompt,
    type: revision.type,
  };
}

async function resolveExact(
  dependencies: NativePromptDependencies,
  groupId: string,
  promptId: string,
  loadedRevision?: PromptRecord | null,
): Promise<ResolvedPrompt | null> {
  let revision = loadedRevision;
  if (revision !== null && !isMatchingRevision(revision, groupId, promptId)) {
    revision = await dependencies.getPrompt(promptId);
  }
  return isMatchingRevision(revision, groupId, promptId) ? resolveValue(revision) : null;
}

async function resolveProduction(
  dependencies: NativePromptDependencies,
  groupId: string,
  loadedGroup?: PromptGroupRecord | null,
): Promise<ResolvedPrompt | null> {
  let group = loadedGroup;
  if (group !== null && group?._id !== groupId) {
    group = await dependencies.getPromptGroup(groupId);
  }
  if (group == null || group.productionId == null) {
    return null;
  }
  if (isMatchingRevision(group.productionPrompt, groupId, group.productionId)) {
    return resolveValue(group.productionPrompt);
  }
  const revision = await dependencies.getPrompt(group.productionId);
  return isMatchingRevision(revision, groupId, group.productionId) ? resolveValue(revision) : null;
}

async function promoteRevision(
  dependencies: NativePromptDependencies,
  promptId: string,
): Promise<{ readonly message: string }> {
  const result = await dependencies.makePromptProduction(promptId);
  if (result.message !== 'Prompt production made successfully') {
    throw new Error(result.message);
  }
  return result;
}

export function createNativePromptAdapter(
  dependencies: NativePromptDependencies,
): PromptSourceAdapter {
  return {
    resolvePrompt: ({ groupId, selection, loadedGroup, loadedRevision }) => {
      if (selection.type === 'exact') {
        return resolveExact(dependencies, groupId, selection.promptId, loadedRevision);
      }
      return resolveProduction(dependencies, groupId, loadedGroup);
    },
    getGroup: dependencies.getPromptGroup,
    getRevision: dependencies.getPrompt,
    listRevisions: dependencies.getPrompts,
    createGroup: dependencies.createPromptGroup,
    addRevision: dependencies.savePrompt,
    promoteRevision: (promptId) => promoteRevision(dependencies, promptId),
    deleteRevision: dependencies.deletePrompt,
  };
}

export function selectionUnavailableReason(selection: PromptSelection): 'production' | 'revision' {
  return selection.type === 'production' ? 'production' : 'revision';
}
