import {
  getNamedType,
  isAbstractType,
  isCompositeType,
  isInterfaceType,
  isObjectType,
  Kind,
  print,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type InlineFragmentNode,
  type SelectionNode,
  type SelectionSetNode,
} from 'graphql';
import type { TypeRelationContext } from './createTypeRelationContext.mts';
import type { ResolvedExpandFragmentsOptions } from './expandFragmentsTypes.mts';

type GraphQLFields = ReturnType<GraphQLObjectType['getFields']>;

interface TypeScope {
  readonly parentType: GraphQLCompositeType;
  // Tracks the concrete runtime types still reachable through nested abstract fragments.
  // This lets union selections drop impossible branches even after narrowing into an interface.
  readonly possibleTypeNames: ReadonlySet<string>;
}

// Start expansion with a scope that records both the syntax parent type and
// the concrete runtime types that can still be reached from that parent.
export function expandSelectionSet(
  schema: GraphQLSchema,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  selectionSet: SelectionSetNode,
  parentType: GraphQLCompositeType,
  fragmentStack: readonly string[],
  options: ResolvedExpandFragmentsOptions
): SelectionSetNode {
  return expandSelectionSetInScope(
    schema,
    fragments,
    selectionSet,
    createTypeScope(schema, parentType),
    fragmentStack,
    options
  );
}

function expandSelectionSetInScope(
  schema: GraphQLSchema,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  selectionSet: SelectionSetNode,
  scope: TypeScope,
  fragmentStack: readonly string[],
  options: ResolvedExpandFragmentsOptions
): SelectionSetNode {
  const expandedSelections = selectionSet.selections.flatMap((selection) =>
    expandSelection(
      schema,
      fragments,
      selection,
      scope,
      fragmentStack,
      options
    )
  );

  return {
    ...selectionSet,
    // Expanding several fragments often produces the same field more than once.
    // Merge after every selection set expansion so nested object fields are also normalized.
    selections: mergeSelections(schema, expandedSelections),
  };
}

// Expand one AST selection while preserving the current runtime type scope.
function expandSelection(
  schema: GraphQLSchema,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  selection: SelectionNode,
  scope: TypeScope,
  fragmentStack: readonly string[],
  options: ResolvedExpandFragmentsOptions
): readonly SelectionNode[] {
  const typeRelations = options.typeRelationContext;
  const { parentType } = scope;
  switch (selection.kind) {
    case Kind.FIELD: {
      if (!selection.selectionSet) {
        return [selection];
      }

      const fieldType = getFieldType(parentType, selection.name.value);
      if (!fieldType || !isCompositeType(fieldType)) {
        return [selection];
      }

      return [
        {
          ...selection,
          selectionSet: expandSelectionSet(
            schema,
            fragments,
            selection.selectionSet,
            fieldType,
            fragmentStack,
            options
          ),
        },
      ];
    }

    case Kind.INLINE_FRAGMENT: {
      const fragmentType = selection.typeCondition
        ? schema.getType(selection.typeCondition.name.value)
        : parentType;

      if (
        !fragmentType ||
        !isCompositeType(fragmentType) ||
        !doesScopeOverlapType(schema, scope, fragmentType)
      ) {
        return [];
      }

      const narrowedScope = narrowTypeScope(
        schema,
        typeRelations,
        scope,
        fragmentType
      );

      if (!canFlattenTypeCondition(typeRelations, parentType, fragmentType)) {
        if (options.distributeAbstractFragments && isAbstractType(fragmentType)) {
          return distributeAbstractFragment(
            schema,
            fragments,
            selection.selectionSet,
            scope,
            fragmentType,
            selection.loc,
            selection.directives,
            fragmentStack,
            options
          );
        }

        if (!options.preserveNarrowingFragments) {
          return [];
        }

        // The fragment narrows to a more specific runtime type. Keep it as an
        // inline fragment so type-specific fields remain valid in the output.
        return [
          {
            ...selection,
            selectionSet: expandSelectionSetInScope(
              schema,
              fragments,
              selection.selectionSet,
              narrowedScope,
              fragmentStack,
              options
            ),
          },
        ];
      }

      return expandSelectionSetInScope(
        schema,
        fragments,
        selection.selectionSet,
        narrowedScope,
        fragmentStack,
        options
      ).selections;
    }

    case Kind.FRAGMENT_SPREAD: {
      const fragmentName = selection.name.value;
      const fragment = fragments.get(fragmentName);
      if (!fragment) {
        return [];
      }

      const fragmentType = schema.getType(fragment.typeCondition.name.value);
      if (
        !fragmentType ||
        !isCompositeType(fragmentType) ||
        !doesScopeOverlapType(schema, scope, fragmentType)
      ) {
        return [];
      }

      if (options.preservedFragmentNames.has(fragmentName)) {
        return [selection];
      }

      if (fragmentStack.includes(fragmentName)) {
        // Fragment spreads can form a graph, so expansion must track the current path.
        // Reporting the whole path makes the problematic cycle easier to locate.
        throw new Error(
          `Circular fragment reference detected: ${[...fragmentStack, fragmentName].join(' -> ')}`
        );
      }

      const narrowedScope = narrowTypeScope(
        schema,
        typeRelations,
        scope,
        fragmentType
      );

      if (!canFlattenTypeCondition(typeRelations, parentType, fragmentType)) {
        if (options.distributeAbstractFragments && isAbstractType(fragmentType)) {
          return distributeAbstractFragment(
            schema,
            fragments,
            fragment.selectionSet,
            scope,
            fragmentType,
            selection.loc,
            selection.directives,
            [...fragmentStack, fragmentName],
            options
          );
        }

        if (!options.preserveNarrowingFragments) {
          return [];
        }

        // A named spread cannot remain in the output because FragmentDefinition nodes
        // are removed. Convert it to an equivalent inline fragment instead.
        return [
          {
            kind: Kind.INLINE_FRAGMENT,
            loc: selection.loc,
            typeCondition: fragment.typeCondition,
            directives: selection.directives,
            selectionSet: expandSelectionSetInScope(
              schema,
              fragments,
              fragment.selectionSet,
              narrowedScope,
              [...fragmentStack, fragmentName],
              options
            ),
          },
        ];
      }

      return expandSelectionSetInScope(
        schema,
        fragments,
        fragment.selectionSet,
        narrowedScope,
        [...fragmentStack, fragmentName],
        options
      ).selections;
    }

    default:
      return throwUnexpectedSelection(selection satisfies never);
  }
}

function throwUnexpectedSelection(selection: never): never {
  throw new Error(`Unexpected selection kind: ${JSON.stringify(selection)}`);
}

// Optional normalization: replace an abstract narrowing fragment with one
// inline fragment per reachable concrete object type.
function distributeAbstractFragment(
  schema: GraphQLSchema,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  selectionSet: SelectionSetNode,
  scope: TypeScope,
  fragmentType: GraphQLCompositeType,
  loc: InlineFragmentNode['loc'],
  directives: InlineFragmentNode['directives'],
  fragmentStack: readonly string[],
  options: ResolvedExpandFragmentsOptions
): readonly SelectionNode[] {
  const selections: SelectionNode[] = [];

  // First apply the abstract condition to the current scope, then re-expand the
  // fragment body once per reachable object so nested type conditions can flatten.
  for (const objectType of getReachableObjectTypes(
    schema,
    narrowTypeScope(schema, options.typeRelationContext, scope, fragmentType)
  )) {
    const expandedSelectionSet = expandSelectionSetInScope(
      schema,
      fragments,
      selectionSet,
      {
        parentType: objectType,
        possibleTypeNames: new Set([objectType.name]),
      },
      fragmentStack,
      options
    );

    if (expandedSelectionSet.selections.length === 0) {
      continue;
    }

    selections.push({
      kind: Kind.INLINE_FRAGMENT,
      loc,
      typeCondition: {
        kind: Kind.NAMED_TYPE,
        name: {
          kind: Kind.NAME,
          value: objectType.name,
        },
      },
      directives,
      selectionSet: expandedSelectionSet,
    });
  }

  return selections;
}

// Merge duplicate fields/fragments first, then apply cross-branch cleanups
// that rely on the merged sibling shape.
function mergeSelections(
  schema: GraphQLSchema,
  selections: readonly SelectionNode[]
): readonly SelectionNode[] {
  const mergedSelections: SelectionNode[] = [];

  // Keep the first occurrence's position stable while folding later compatible selections into it.
  const fieldIndexes = new Map<string, number>();
  const inlineFragmentIndexes = new Map<string, number>();

  for (const selection of selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        const key = getFieldMergeKey(selection);
        const existingIndex = fieldIndexes.get(key);
        if (existingIndex == null) {
          fieldIndexes.set(key, mergedSelections.length);
          mergedSelections.push(selection);
          continue;
        }

        const existingSelection = mergedSelections[existingIndex];
        if (existingSelection?.kind !== Kind.FIELD) {
          continue;
        }

        mergedSelections[existingIndex] = mergeFields(
          schema,
          existingSelection,
          selection
        );
        continue;
      }

      case Kind.INLINE_FRAGMENT: {
        const key = getInlineFragmentMergeKey(selection);
        const existingIndex = inlineFragmentIndexes.get(key);
        if (existingIndex == null) {
          inlineFragmentIndexes.set(key, mergedSelections.length);
          mergedSelections.push(selection);
          continue;
        }

        const existingSelection = mergedSelections[existingIndex];
        if (existingSelection?.kind !== Kind.INLINE_FRAGMENT) {
          continue;
        }

        mergedSelections[existingIndex] = mergeInlineFragments(
          schema,
          existingSelection,
          selection
        );
        continue;
      }

      case Kind.FRAGMENT_SPREAD:
        mergedSelections.push(selection);
        continue;

      default:
        throwUnexpectedSelection(selection satisfies never);
    }
  }

  return removeRedundantInlineFragmentFields(
    hoistNestedInlineFragmentsToSiblings(schema, mergedSelections)
  );
}

function removeRedundantInlineFragmentFields(
  selections: readonly SelectionNode[]
): readonly SelectionNode[] {
  const coveringFieldKeys = new Set<string>();

  // A leaf field selected directly in this selection set also applies to each
  // nested inline fragment branch, so the same leaf field inside the branch is redundant.
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD && !selection.selectionSet) {
      coveringFieldKeys.add(getFieldMergeKey(selection));
    }
  }

  if (coveringFieldKeys.size === 0) {
    return selections;
  }

  const prunedSelections: SelectionNode[] = [];

  for (const selection of selections) {
    if (selection.kind !== Kind.INLINE_FRAGMENT) {
      prunedSelections.push(selection);
      continue;
    }

    const nestedSelections = selection.selectionSet.selections.filter(
      (nestedSelection) =>
        nestedSelection.kind !== Kind.FIELD ||
        nestedSelection.selectionSet != null ||
        !coveringFieldKeys.has(getFieldMergeKey(nestedSelection))
    );

    if (nestedSelections.length === 0) {
      continue;
    }

    prunedSelections.push({
      ...selection,
      selectionSet: {
        ...selection.selectionSet,
        selections: nestedSelections,
      },
    });
  }

  return prunedSelections;
}

// Move directive-free concrete fragments into matching sibling fragments when
// doing so preserves the same runtime conditions.
function hoistNestedInlineFragmentsToSiblings(
  schema: GraphQLSchema,
  selections: readonly SelectionNode[]
): readonly SelectionNode[] {
  const siblingFragmentIndexes = new Map<string, number>();

  for (const [index, selection] of selections.entries()) {
    if (!isConcreteInlineFragment(schema, selection)) {
      continue;
    }

    siblingFragmentIndexes.set(getInlineFragmentMergeKey(selection), index);
  }

  if (siblingFragmentIndexes.size === 0) {
    return selections;
  }

  const hoistedFragments: InlineFragmentNode[] = [];
  const nextSelections = selections.flatMap((selection, index) => {
    if (selection.kind !== Kind.INLINE_FRAGMENT || hasDirectives(selection)) {
      return [selection];
    }

    const result = removeHoistableNestedInlineFragments(
      schema,
      selection.selectionSet.selections,
      siblingFragmentIndexes,
      index,
      hoistedFragments
    );

    if (!result.changed) {
      return [selection];
    }

    if (result.selections.length === 0) {
      return [];
    }

    return [
      {
        ...selection,
        selectionSet: {
          ...selection.selectionSet,
          selections: result.selections,
        },
      },
    ];
  });

  if (hoistedFragments.length === 0) {
    return selections;
  }

  return mergeHoistedInlineFragments(schema, nextSelections, hoistedFragments);
}

// Walk a branch looking for concrete fragments that can be merged into a
// different sibling fragment at the original selection-set level.
function removeHoistableNestedInlineFragments(
  schema: GraphQLSchema,
  selections: readonly SelectionNode[],
  siblingFragmentIndexes: ReadonlyMap<string, number>,
  sourceSiblingIndex: number,
  hoistedFragments: InlineFragmentNode[]
): { readonly changed: boolean; readonly selections: readonly SelectionNode[] } {
  let changed = false;
  const nextSelections: SelectionNode[] = [];

  for (const selection of selections) {
    if (selection.kind !== Kind.INLINE_FRAGMENT) {
      nextSelections.push(selection);
      continue;
    }

    const key = getInlineFragmentMergeKey(selection);
    const targetSiblingIndex = siblingFragmentIndexes.get(key);
    if (
      isConcreteInlineFragment(schema, selection) &&
      targetSiblingIndex != null &&
      targetSiblingIndex !== sourceSiblingIndex
    ) {
      hoistedFragments.push(selection);
      changed = true;
      continue;
    }

    if (hasDirectives(selection)) {
      nextSelections.push(selection);
      continue;
    }

    const result = removeHoistableNestedInlineFragments(
      schema,
      selection.selectionSet.selections,
      siblingFragmentIndexes,
      sourceSiblingIndex,
      hoistedFragments
    );

    if (!result.changed) {
      nextSelections.push(selection);
      continue;
    }

    changed = true;
    if (result.selections.length === 0) {
      continue;
    }

    nextSelections.push({
      ...selection,
      selectionSet: {
        ...selection.selectionSet,
        selections: result.selections,
      },
    });
  }

  return { changed, selections: nextSelections };
}

// Fold fragments collected from nested branches into their matching siblings.
function mergeHoistedInlineFragments(
  schema: GraphQLSchema,
  selections: readonly SelectionNode[],
  hoistedFragments: readonly InlineFragmentNode[]
): readonly SelectionNode[] {
  const mergedSelections = [...selections];
  const siblingFragmentIndexes = new Map<string, number>();

  for (const [index, selection] of mergedSelections.entries()) {
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      siblingFragmentIndexes.set(getInlineFragmentMergeKey(selection), index);
    }
  }

  for (const fragment of hoistedFragments) {
    const index = siblingFragmentIndexes.get(getInlineFragmentMergeKey(fragment));
    if (index == null) {
      continue;
    }

    const existingSelection = mergedSelections[index];
    if (existingSelection?.kind !== Kind.INLINE_FRAGMENT) {
      continue;
    }

    mergedSelections[index] = mergeInlineFragments(
      schema,
      existingSelection,
      fragment
    );
  }

  return mergedSelections;
}

// Only object-type fragments are safe hoist targets; abstract fragments may
// still include runtime branches that should remain nested.
function isConcreteInlineFragment(
  schema: GraphQLSchema,
  selection: SelectionNode
): selection is InlineFragmentNode {
  if (selection.kind !== Kind.INLINE_FRAGMENT || !selection.typeCondition) {
    return false;
  }

  return isObjectType(schema.getType(selection.typeCondition.name.value));
}

function hasDirectives(selection: InlineFragmentNode): boolean {
  return (selection.directives?.length ?? 0) > 0;
}

function getInlineFragmentMergeKey(fragment: InlineFragmentNode): string {
  return [
    fragment.typeCondition?.name.value ?? '',
    fragment.directives?.map((directive) => print(directive)).join(',') ?? '',
  ].join('\0');
}

function mergeInlineFragments(
  schema: GraphQLSchema,
  existingFragment: InlineFragmentNode,
  nextFragment: InlineFragmentNode
): InlineFragmentNode {
  return {
    ...existingFragment,
    selectionSet: {
      ...existingFragment.selectionSet,
      selections: mergeSelections(schema, [
        ...existingFragment.selectionSet.selections,
        ...nextFragment.selectionSet.selections,
      ]),
    },
  };
}

function getFieldMergeKey(field: FieldNode): string {
  // Alias, arguments, and directives affect the response shape or execution, so
  // only fields with matching printed metadata are considered merge-compatible.
  return [
    field.alias?.value ?? field.name.value,
    field.name.value,
    field.arguments?.map((argument) => print(argument)).join(',') ?? '',
    field.directives?.map((directive) => print(directive)).join(',') ?? '',
  ].join('\0');
}

function mergeFields(
  schema: GraphQLSchema,
  existingField: FieldNode,
  nextField: FieldNode
): FieldNode {
  if (!existingField.selectionSet || !nextField.selectionSet) {
    return existingField;
  }

  return {
    ...existingField,
    selectionSet: {
      ...existingField.selectionSet,
      selections: mergeSelections(schema, [
        ...existingField.selectionSet.selections,
        ...nextField.selectionSet.selections,
      ]),
    },
  };
}

function getFieldType(
  parentType: GraphQLCompositeType,
  fieldName: string
): GraphQLNamedType | undefined {
  if (fieldName === '__typename') {
    return undefined;
  }

  const fields = getFields(parentType);
  const field = fields?.[fieldName];
  if (!field) {
    return undefined;
  }

  return getNamedType(field.type);
}

function getFields(
  parentType: GraphQLCompositeType
): GraphQLFields | undefined {
  if (isObjectType(parentType) || isInterfaceType(parentType)) {
    return parentType.getFields();
  }

  return undefined;
}

function createTypeScope(
  schema: GraphQLSchema,
  parentType: GraphQLCompositeType
): TypeScope {
  return {
    parentType,
    possibleTypeNames: getPossibleTypeNames(schema, parentType),
  };
}

function narrowTypeScope(
  schema: GraphQLSchema,
  typeRelations: TypeRelationContext,
  scope: TypeScope,
  conditionType: GraphQLCompositeType
): TypeScope {
  // Keep the syntax parent used for field lookups separate from the concrete
  // type set used to prune impossible inline fragment branches.
  return {
    parentType: narrowParentType(
      typeRelations,
      scope.parentType,
      conditionType
    ),
    possibleTypeNames: intersectTypeNames(
      scope.possibleTypeNames,
      getPossibleTypeNames(schema, conditionType)
    ),
  };
}

// Scope overlap is based on reachable concrete types, not just GraphQL.js'
// parent/condition overlap, so union constraints survive interface narrowing.
function doesScopeOverlapType(
  schema: GraphQLSchema,
  scope: TypeScope,
  conditionType: GraphQLCompositeType
): boolean {
  for (const typeName of getPossibleTypeNames(schema, conditionType)) {
    if (scope.possibleTypeNames.has(typeName)) {
      return true;
    }
  }

  return false;
}

// Normalize every composite type into its possible concrete object names.
function getPossibleTypeNames(
  schema: GraphQLSchema,
  type: GraphQLCompositeType
): ReadonlySet<string> {
  if (isObjectType(type)) {
    return new Set([type.name]);
  }

  if (isAbstractType(type)) {
    return new Set(schema.getPossibleTypes(type).map(({ name }) => name));
  }

  return new Set();
}

function intersectTypeNames(
  typeNamesA: ReadonlySet<string>,
  typeNamesB: ReadonlySet<string>
): ReadonlySet<string> {
  const intersection = new Set<string>();

  for (const typeName of typeNamesA) {
    if (typeNamesB.has(typeName)) {
      intersection.add(typeName);
    }
  }

  return intersection;
}

function getReachableObjectTypes(
  schema: GraphQLSchema,
  scope: TypeScope
): readonly GraphQLObjectType[] {
  const objectTypes: GraphQLObjectType[] = [];

  for (const typeName of scope.possibleTypeNames) {
    const type = schema.getType(typeName);
    if (isObjectType(type)) {
      objectTypes.push(type);
    }
  }

  return objectTypes;
}

// Flatten only when every selection remains valid directly under the current
// parent type; otherwise keep an inline fragment around the narrowed fields.
function canFlattenTypeCondition(
  typeRelations: TypeRelationContext,
  parentType: GraphQLCompositeType,
  conditionType: GraphQLCompositeType
): boolean {
  if (!typeRelations.doesOverlap(parentType, conditionType)) {
    return false;
  }

  // Object selections already know their concrete runtime type, so overlapping
  // fragment conditions can be flattened into the object selection.
  if (isObjectType(parentType) || parentType.name === conditionType.name) {
    return true;
  }

  // Interface-to-parent-interface fragments are safe to flatten because every
  // possible object for the current interface also implements the condition.
  return (
    isInterfaceType(parentType) &&
    isInterfaceType(conditionType) &&
    typeRelations.interfaceImplements(parentType, conditionType)
  );
}

// Choose the parent type to use for field lookups while expanding inside the
// fragment condition.
function narrowParentType(
  typeRelations: TypeRelationContext,
  parentType: GraphQLCompositeType,
  conditionType: GraphQLCompositeType
): GraphQLCompositeType {
  // Preserve the current parent type when the condition is known to cover all of it.
  // Otherwise the selection is being evaluated in the fragment condition's type.
  if (
    isObjectType(parentType) ||
    parentType.name === conditionType.name ||
    (isInterfaceType(parentType) &&
      isInterfaceType(conditionType) &&
      typeRelations.interfaceImplements(parentType, conditionType))
  ) {
    return parentType;
  }

  return conditionType;
}
