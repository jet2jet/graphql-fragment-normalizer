import type { FragmentDefinitionNode } from 'graphql';
import type { TypeRelationContext } from './createTypeRelationContext.mts';

export type FragmentDefinitionsMode = 'drop' | 'normalize' | 'preserve';
export type MissingFragmentBehavior = 'error' | 'warn' | 'ignore';

/**
 * Controls how fragments are expanded from a GraphQL document.
 */
export interface ExpandFragmentsOptions {
  /** Fragment definitions supplied outside of the document being expanded. */
  readonly additionalFragments?: readonly FragmentDefinitionNode[];
  /**
   * Expands only the operation with this name. All other operations are left unchanged.
   * `null` or `undefined` (or missing) means all operations will be changed.
   */
  readonly operationName?: string | null | undefined;
  /**
   * Keeps fragments that narrow from the current type to a more specific type as inline fragments.
   *
   * When true, a spread such as `...UserFields` on a `Node` selection can become
   * `... on User { ... }` instead of being dropped. Fragments that can be safely
   * flattened into the current type are still flattened.
   */
  readonly preserveNarrowingFragments?: boolean;
  /**
   * Emits abstract narrowing fragments as inline fragments for each reachable concrete object type.
   *
   * When true, a spread such as `...NodeFields` on a union can become
   * `... on Owner { ... }` and `... on Admin { ... }` instead of keeping
   * `... on Node { ... }`.
   */
  readonly distributeAbstractFragments?: boolean;
  /**
   * Keeps named fragment spreads when the fragment is used at least this many times.
   *
   * Values less than or equal to `0` disable this behavior, so named fragments are always
   * expanded. Usage is counted across operation selections and fragment-to-fragment
   * references. When a fragment is kept, its FragmentDefinition is also kept as-is.
   */
  readonly preserveNamedFragmentsUsedAtLeast?: number;
  /**
   * Controls how FragmentDefinition nodes from the input document are emitted.
   *
   * - `drop` (default): removes FragmentDefinition nodes after expansion.
   * - `preserve`: keeps FragmentDefinition nodes exactly as they were in the input document.
   * - `normalize`: keeps FragmentDefinition nodes and normalizes their selection sets too.
   *
   * `preserve` is useful for code generators that need colocated fragment type definitions.
   * In that mode retained named fragments are intentionally not normalized, because changing
   * their shape can change the type definitions produced for colocated fragments.
   */
  readonly fragmentDefinitionsMode?: FragmentDefinitionsMode;
  /**
   * Controls what happens when a named fragment spread references a fragment definition
   * that is not present in the input document or additional fragments.
   *
   * - `error` (default): throws an error.
   * - `warn`: emits a warning and omits the unresolved spread.
   * - `ignore`: omits the unresolved spread without reporting it.
   */
  readonly missingFragmentBehavior?: MissingFragmentBehavior;
  /**
   * Used for calculating type relations (parent/child or etc.).
   * You can create by using {@linkcode createTypeRelationContext} and re-use it whenever the schema is unchanged.
   */
  readonly typeRelationContext?: TypeRelationContext;
}

export interface ResolvedExpandFragmentsOptions {
  readonly additionalFragments: readonly FragmentDefinitionNode[];
  readonly fragmentDefinitionsMode: FragmentDefinitionsMode;
  readonly missingFragmentBehavior: MissingFragmentBehavior;
  readonly operationName: string | null;
  readonly distributeAbstractFragments: boolean;
  readonly preserveNamedFragmentsUsedAtLeast: number;
  readonly preserveNarrowingFragments: boolean;
  readonly preservedFragmentNames: ReadonlySet<string>;
  readonly typeRelationContext: TypeRelationContext;
}
