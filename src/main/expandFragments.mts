import {
  isCompositeType,
  Kind,
  visit,
  type DefinitionNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
} from 'graphql';
import createTypeRelationContext from './createTypeRelationContext.mts';
import type {
  ExpandFragmentsOptions,
  ResolvedExpandFragmentsOptions,
} from './expandFragmentsTypes.mts';
import {
  pushFragmentDefinition,
  pushRetainedAdditionalFragmentDefinitions,
} from './fragmentDefinitions.mts';
import {
  collectPreservedFragmentNames,
  getFragmentPreservationRoots,
} from './fragmentUsage.mts';
import { getOperationRootType, shouldExpandOperation } from './operationUtils.mts';
import { expandSelectionSet } from './selectionExpander.mts';

export type {
  ExpandFragmentsOptions,
  FragmentDefinitionsMode,
} from './expandFragmentsTypes.mts';

/**
 * Expands fragment spreads and inline fragments inside a DocumentNode using schema type information.
 *
 * Fragment definitions are removed from the returned document. Selections that are not valid for the
 * current type are omitted, while narrowing fragments can be preserved as inline fragments by default.
 */
export default function expandFragments(
  schema: GraphQLSchema,
  document: DocumentNode,
  options: ExpandFragmentsOptions = {}
): DocumentNode {
  const fragments = collectFragments(document, options.additionalFragments ?? []);
  const resolvedOptions = resolveOptions(schema, document, fragments, options);
  const definitions: DefinitionNode[] = [];
  const emittedFragmentDefinitionNames = new Set<string>();

  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      pushFragmentDefinition(
        schema,
        fragments,
        definition,
        resolvedOptions,
        definitions,
        emittedFragmentDefinitionNames
      );
      continue;
    }

    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      definitions.push(definition);
      continue;
    }

    if (!shouldExpandOperation(definition, resolvedOptions.operationName)) {
      definitions.push(definition);
      continue;
    }

    const rootType = getOperationRootType(schema, definition);
    if (!rootType) {
      definitions.push(definition);
      continue;
    }

    definitions.push({
      ...definition,
      selectionSet: expandSelectionSet(
        schema,
        fragments,
        definition.selectionSet,
        rootType,
        [],
        resolvedOptions
      ),
    });
  }

  pushRetainedAdditionalFragmentDefinitions(
    fragments,
    resolvedOptions,
    definitions,
    emittedFragmentDefinitionNames
  );

  return {
    ...document,
    definitions,
  };
}

/**
 * Expands fragment spreads and inline fragments inside a FragmentDefinitionNode using schema type information.
 */
export function expandFragmentsInFragment(
  schema: GraphQLSchema,
  fragment: FragmentDefinitionNode,
  options: ExpandFragmentsOptions = {}
): FragmentDefinitionNode {
  const additionalFragments = options.additionalFragments ?? [];
  const fragments = collectAdditionalFragments(additionalFragments);
  const resolvedOptions = resolveFragmentOptions(
    schema,
    fragment,
    additionalFragments,
    fragments,
    options
  );
  const type = schema.getType(fragment.typeCondition.name.value);
  if (!isCompositeType(type)) {
    return {
      ...fragment,
    };
  }

  return {
    ...fragment,
    selectionSet: expandSelectionSet(
      schema,
      fragments,
      fragment.selectionSet,
      type,
      [],
      resolvedOptions
    ),
  };
}

function collectFragments(
  document: DocumentNode,
  additionalFragments: readonly FragmentDefinitionNode[]
): ReadonlyMap<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();

  // Collect in-document fragments with visit so the implementation stays AST-based.
  visit(document, {
    FragmentDefinition(fragment) {
      fragments.set(fragment.name.value, fragment);
    },
  });

  for (const fragment of additionalFragments) {
    fragments.set(fragment.name.value, fragment);
  }

  return fragments;
}

function collectAdditionalFragments(
  additionalFragments: readonly FragmentDefinitionNode[]
): ReadonlyMap<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();

  for (const fragment of additionalFragments) {
    fragments.set(fragment.name.value, fragment);
  }

  return fragments;
}

function resolveOptions(
  schema: GraphQLSchema,
  document: DocumentNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  options: ExpandFragmentsOptions
): ResolvedExpandFragmentsOptions {
  const additionalFragments = options.additionalFragments ?? [];
  const fragmentDefinitionsMode = options.fragmentDefinitionsMode ?? 'drop';
  const operationName = options.operationName ?? null;
  const preserveNamedFragmentsUsedAtLeast =
    options.preserveNamedFragmentsUsedAtLeast ?? 0;

  return {
    additionalFragments,
    fragmentDefinitionsMode,
    operationName,
    preserveNamedFragmentsUsedAtLeast,
    preserveNarrowingFragments: options.preserveNarrowingFragments ?? true,
    preservedFragmentNames: collectPreservedFragmentNames(
      fragments,
      getFragmentPreservationRoots(
        document,
        fragmentDefinitionsMode,
        operationName
      ),
      preserveNamedFragmentsUsedAtLeast
    ),
    typeRelationContext:
      options.typeRelationContext ?? createTypeRelationContext(schema),
  };
}

function resolveFragmentOptions(
  schema: GraphQLSchema,
  fragment: FragmentDefinitionNode,
  additionalFragments: readonly FragmentDefinitionNode[],
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  options: ExpandFragmentsOptions
): ResolvedExpandFragmentsOptions {
  const preserveNamedFragmentsUsedAtLeast =
    options.preserveNamedFragmentsUsedAtLeast ?? 0;

  return {
    additionalFragments,
    fragmentDefinitionsMode: options.fragmentDefinitionsMode ?? 'drop',
    operationName: options.operationName ?? null,
    preserveNamedFragmentsUsedAtLeast,
    preserveNarrowingFragments: options.preserveNarrowingFragments ?? true,
    preservedFragmentNames: collectPreservedFragmentNames(
      fragments,
      [fragment, ...additionalFragments],
      preserveNamedFragmentsUsedAtLeast
    ),
    typeRelationContext:
      options.typeRelationContext ?? createTypeRelationContext(schema),
  };
}
