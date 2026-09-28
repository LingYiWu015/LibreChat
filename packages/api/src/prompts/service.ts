import type {
  PromptRecord,
  ResolvedPrompt,
  PromptListResult,
  PromptSourceAdapter,
  PromptStore,
  PromptCreationResult,
  PromptListInput,
  ResolvePromptInput,
  PromptServiceResult,
  PromptGroupRecord,
  PromptServiceDependencies,
  CreatePromptGroupInput,
  AddPromptRevisionInput,
} from './types';
import type { ProjectedStoredPrompt, ProjectedStoredPromptGroup } from './protection';
import type { TUpdatePromptGroupSchema } from './schemas';
import {
  inspectPromptContent,
  projectStoredPrompt,
  projectStoredPrompts,
  projectStoredPromptGroup,
  projectStoredPromptGroups,
} from './protection';
import { selectionUnavailableReason } from './native';
import { validatePromptGroupUpdate } from './schemas';

type PromptFilters = ResolvePromptInput['filters'];
type WithPromptFilters<T> = T & { readonly filters?: PromptFilters };

export interface PromptServiceListResult extends Omit<PromptListResult, 'data'> {
  readonly data: readonly ProjectedStoredPromptGroup<PromptGroupRecord>[];
}

export interface PromptService {
  resolvePrompt(input: ResolvePromptInput): Promise<PromptServiceResult<ResolvedPrompt>>;
  listGroups(input: PromptListInput): Promise<PromptServiceListResult>;
  listRevisions(input: {
    readonly groupId: string;
    readonly filters?: PromptFilters;
  }): Promise<readonly ProjectedStoredPrompt<PromptRecord>[]>;
  createGroup(
    input: WithPromptFilters<CreatePromptGroupInput>,
  ): Promise<PromptServiceResult<PromptCreationResult>>;
  addRevision(
    input: WithPromptFilters<AddPromptRevisionInput>,
  ): Promise<PromptServiceResult<{ readonly prompt: PromptRecord }>>;
  getGroup(input: {
    readonly groupId: string;
    readonly loadedGroup?: PromptGroupRecord | null;
    readonly filters?: PromptFilters;
  }): Promise<PromptServiceResult<ProjectedStoredPromptGroup<PromptGroupRecord> | null>>;
  getRevision(input: {
    readonly promptId: string;
    readonly loadedRevision?: PromptRecord | null;
    readonly filters?: PromptFilters;
  }): Promise<PromptServiceResult<ProjectedStoredPrompt<PromptRecord> | null>>;
  incrementUsage(groupId: string): ReturnType<PromptStore['incrementUsage']>;
  updateGroup(input: {
    readonly groupId: string;
    readonly updates: TUpdatePromptGroupSchema;
    readonly filters?: PromptFilters;
  }): Promise<PromptServiceResult<PromptGroupRecord>>;
  promoteRevision(input: {
    readonly promptId: string;
    readonly loadedRevision?: PromptRecord | null;
    readonly filters?: PromptFilters;
  }): Promise<PromptServiceResult<Awaited<ReturnType<PromptSourceAdapter['promoteRevision']>>>>;
  deleteRevision(
    input: Parameters<PromptSourceAdapter['deleteRevision']>[0],
  ): ReturnType<PromptSourceAdapter['deleteRevision']>;
  deleteGroup(groupId: string): ReturnType<PromptStore['deleteGroup']>;
  deleteUserPrompts(userId: string): ReturnType<PromptStore['deleteUserPrompts']>;
}

function invalidInput<T>(message: string): PromptServiceResult<T> {
  return { ok: false, error: { type: 'invalid_input', message } };
}

function blockedContent<T>(
  finding: NonNullable<ReturnType<typeof inspectPromptContent>>,
): PromptServiceResult<T> {
  return { ok: false, error: { type: 'blocked_content', finding } };
}

function inspect<T>(
  input: Parameters<typeof inspectPromptContent>[0],
  filters: Parameters<typeof inspectPromptContent>[1],
): PromptServiceResult<T> | null {
  const finding = inspectPromptContent(input, filters);
  return finding == null ? null : blockedContent(finding);
}

function validateRevisionInput<T>(
  input: Pick<AddPromptRevisionInput, 'prompt'>,
): PromptServiceResult<T> | null {
  if (typeof input.prompt.prompt !== 'string' || input.prompt.prompt.trim().length === 0) {
    return invalidInput('Prompt text is required and must be a non-empty string');
  }
  if (input.prompt.type !== 'text' && input.prompt.type !== 'chat') {
    return invalidInput('Prompt type must be text or chat');
  }
  return null;
}

export function createPromptService(dependencies: PromptServiceDependencies): PromptService {
  const { source, store, grantCreatorOwnership, logger } = dependencies;

  return {
    async resolvePrompt(input: ResolvePromptInput) {
      const { filters, ...sourceInput } = input;
      const resolved = await source.resolvePrompt(sourceInput);
      if (resolved == null) {
        return {
          ok: false,
          error: {
            type: 'unavailable_selection',
            reason: selectionUnavailableReason(input.selection),
          },
        } as const;
      }
      const rejection = inspect<typeof resolved>({ prompt: resolved.prompt }, filters);
      return rejection ?? ({ ok: true, value: resolved } as const);
    },

    async listGroups(input: PromptListInput) {
      const { filters, forReuse, ...storeInput } = input;
      const result = await store.listGroups(storeInput);
      const publicIds = new Set(input.publiclyAccessibleIds);
      const groups = result.data.map((group) =>
        publicIds.has(group._id) ? { ...group, isPublic: true } : group,
      );
      return {
        data: projectStoredPromptGroups(groups, filters, { forReuse }),
        has_more: result.has_more,
        after: result.after,
      };
    },

    async listRevisions(input: {
      readonly groupId: string;
      readonly filters?: ResolvePromptInput['filters'];
    }) {
      return projectStoredPrompts(await source.listRevisions(input.groupId), input.filters);
    },

    async createGroup(
      input: CreatePromptGroupInput & { readonly filters?: ResolvePromptInput['filters'] },
    ): Promise<PromptServiceResult<Awaited<ReturnType<typeof source.createGroup>>>> {
      if (input.group.name.trim().length === 0) {
        return invalidInput('Prompt and group name are required');
      }
      const rejection = inspect<Awaited<ReturnType<typeof source.createGroup>>>(
        { prompt: input.prompt, group: input.group },
        input.filters,
      );
      if (rejection != null) {
        return rejection;
      }
      const { filters: _filters, ...createInput } = input;
      const value = await source.createGroup(createInput);
      try {
        await grantCreatorOwnership({ userId: input.author, groupId: value.prompt.groupId });
      } catch (error) {
        logger.error(
          `Failed to grant creator ownership for prompt group ${value.prompt.groupId}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return { ok: true, value };
    },

    async addRevision(
      input: AddPromptRevisionInput & { readonly filters?: ResolvePromptInput['filters'] },
    ): Promise<PromptServiceResult<Awaited<ReturnType<typeof source.addRevision>>>> {
      const validation =
        validateRevisionInput<Awaited<ReturnType<typeof source.addRevision>>>(input);
      if (validation != null) {
        return validation;
      }
      const rejection = inspect<Awaited<ReturnType<typeof source.addRevision>>>(
        { prompt: input.prompt },
        input.filters,
      );
      if (rejection != null) {
        return rejection;
      }
      const { filters: _filters, ...addInput } = input;
      return { ok: true, value: await source.addRevision(addInput) };
    },

    async getGroup(input: {
      readonly groupId: string;
      readonly loadedGroup?: PromptGroupRecord | null;
      readonly filters?: ResolvePromptInput['filters'];
    }): Promise<
      PromptServiceResult<ReturnType<typeof projectStoredPromptGroup<PromptGroupRecord>>>
    > {
      const group =
        input.loadedGroup?._id === input.groupId
          ? input.loadedGroup
          : await source.getGroup(input.groupId);
      if (group == null) {
        return { ok: true, value: null };
      }
      const rejection = inspect<PromptGroupRecord | null>({ group }, input.filters);
      if (rejection != null) {
        return rejection;
      }
      return { ok: true, value: projectStoredPromptGroup(group, input.filters) };
    },

    async getRevision(input: {
      readonly promptId: string;
      readonly loadedRevision?: PromptRecord | null;
      readonly filters?: ResolvePromptInput['filters'];
    }): Promise<PromptServiceResult<ReturnType<typeof projectStoredPrompt<PromptRecord>> | null>> {
      const revision =
        input.loadedRevision?._id === input.promptId
          ? input.loadedRevision
          : await source.getRevision(input.promptId);
      if (revision == null) {
        return { ok: true, value: null };
      }
      const rejection = inspect<PromptRecord>({ prompt: revision }, input.filters);
      if (rejection != null) {
        return rejection;
      }
      return { ok: true, value: projectStoredPrompt(revision, input.filters) };
    },

    incrementUsage: store.incrementUsage,

    async updateGroup(input: {
      readonly groupId: string;
      readonly updates: TUpdatePromptGroupSchema;
      readonly filters?: ResolvePromptInput['filters'];
    }): Promise<PromptServiceResult<PromptGroupRecord>> {
      const updates = validatePromptGroupUpdate(input.updates);
      const rejection = inspect<PromptGroupRecord>(updates, input.filters);
      if (rejection != null) {
        return rejection;
      }
      return { ok: true, value: await store.updateGroup(input.groupId, updates) };
    },

    async promoteRevision(input: {
      readonly promptId: string;
      readonly loadedRevision?: PromptRecord | null;
      readonly filters?: ResolvePromptInput['filters'];
    }) {
      const revision =
        input.loadedRevision?._id === input.promptId
          ? input.loadedRevision
          : await source.getRevision(input.promptId);
      if (revision == null) {
        return {
          ok: false,
          error: { type: 'unavailable_selection', reason: 'revision' },
        } as const;
      }
      const rejection = inspect<Awaited<ReturnType<typeof source.promoteRevision>>>(
        { prompt: revision },
        input.filters,
      );
      if (rejection != null) {
        return rejection;
      }
      return { ok: true, value: await source.promoteRevision(input.promptId) } as const;
    },

    deleteRevision: source.deleteRevision,
    deleteGroup: store.deleteGroup,
    deleteUserPrompts: store.deleteUserPrompts,
  };
}
