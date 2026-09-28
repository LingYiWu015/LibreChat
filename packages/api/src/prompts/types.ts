import type {
  FiltersConfig,
  TDeletePromptResponse,
  TMakePromptProductionResponse,
} from 'librechat-data-provider';
import type { ProtectionFinding } from '../protection/types';
import type { TUpdatePromptGroupSchema } from './schemas';

export type PromptKind = 'text' | 'chat';
export type PromptTimestamp = string | Date;

export interface PromptRecord {
  readonly _id: string;
  readonly groupId: string;
  readonly author: string;
  readonly prompt: string;
  readonly type: PromptKind;
  readonly createdAt?: PromptTimestamp;
  readonly updatedAt?: PromptTimestamp;
  readonly tenantId?: string;
}

export interface PromptProjection {
  readonly _id: string;
  readonly prompt: string;
  readonly groupId?: string;
  readonly author?: string;
  readonly type?: PromptKind;
}

export interface PromptGroupRecord {
  readonly _id: string;
  readonly name: string;
  readonly author: string;
  readonly authorName: string;
  readonly numberOfGenerations?: number;
  readonly command?: string | null;
  readonly oneliner?: string;
  readonly category?: string;
  readonly productionId?: string | null;
  readonly productionPrompt?: PromptRecord | PromptProjection | null;
  readonly isPublic?: boolean;
  readonly createdAt?: PromptTimestamp;
  readonly updatedAt?: PromptTimestamp;
  readonly tenantId?: string;
}

export type PromptSelection =
  | { readonly type: 'production' }
  | { readonly type: 'exact'; readonly promptId: string };

export interface ResolvedPrompt {
  readonly groupId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly type: PromptKind;
}

export interface CreatePromptGroupInput {
  readonly prompt: { readonly prompt: string; readonly type: PromptKind };
  readonly group: {
    readonly name: string;
    readonly category?: string;
    readonly oneliner?: string;
    readonly command?: string | null;
  };
  readonly author: string;
  readonly authorName: string;
}

export interface AddPromptRevisionInput {
  readonly groupId: string;
  readonly prompt: { readonly prompt: string; readonly type: PromptKind };
  readonly author: string;
}

export interface PromptCreationResult {
  readonly prompt: PromptRecord;
  readonly group: PromptGroupRecord;
}

export interface PromptListResult {
  readonly data: readonly PromptGroupRecord[];
  readonly has_more: boolean;
  readonly after: string | null;
}

export interface PromptListInput {
  readonly accessibleIds: readonly string[];
  readonly publiclyAccessibleIds: readonly string[];
  readonly ownedPromptGroupIds: readonly string[];
  readonly name?: string;
  readonly category?: string;
  readonly limit: number | null;
  readonly after: string | null;
  readonly forReuse: boolean;
  readonly filters?: FiltersConfig;
}

export type PromptServiceError =
  | { readonly type: 'invalid_input'; readonly message: string }
  | { readonly type: 'blocked_content'; readonly finding: ProtectionFinding }
  | {
      readonly type: 'unavailable_selection';
      readonly reason: 'production' | 'revision';
    };

export type PromptServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PromptServiceError };

export interface ResolvePromptInput {
  readonly groupId: string;
  readonly selection: PromptSelection;
  readonly loadedGroup?: PromptGroupRecord | null;
  readonly loadedRevision?: PromptRecord | null;
  readonly filters?: FiltersConfig;
}

export interface PromptSourceAdapter {
  resolvePrompt(input: Omit<ResolvePromptInput, 'filters'>): Promise<ResolvedPrompt | null>;
  getGroup(groupId: string): Promise<PromptGroupRecord | null>;
  getRevision(promptId: string): Promise<PromptRecord | null>;
  listRevisions(groupId: string): Promise<readonly PromptRecord[]>;
  createGroup(input: CreatePromptGroupInput): Promise<PromptCreationResult>;
  addRevision(input: AddPromptRevisionInput): Promise<{ readonly prompt: PromptRecord }>;
  promoteRevision(promptId: string): Promise<TMakePromptProductionResponse>;
  deleteRevision(input: {
    readonly groupId: string;
    readonly promptId: string;
  }): Promise<TDeletePromptResponse>;
}

export interface PromptStore {
  listGroups(input: Omit<PromptListInput, 'filters' | 'forReuse'>): Promise<PromptListResult>;
  updateGroup(groupId: string, updates: TUpdatePromptGroupSchema): Promise<PromptGroupRecord>;
  incrementUsage(groupId: string): Promise<{ readonly numberOfGenerations: number }>;
  deleteGroup(groupId: string): Promise<{ readonly message: string }>;
  deleteUserPrompts(userId: string): Promise<void>;
}

export interface PromptServiceDependencies {
  readonly source: PromptSourceAdapter;
  readonly store: PromptStore;
  readonly grantCreatorOwnership: (input: {
    readonly userId: string;
    readonly groupId: string;
  }) => Promise<void>;
  readonly logger: {
    error(message: string, error: Error): void;
  };
}
