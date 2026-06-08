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
    selections: mergeSelections(expandedSelections),
  };
}

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

function mergeSelections(
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

  return mergedSelections;
}

function getInlineFragmentMergeKey(fragment: InlineFragmentNode): string {
  return [
    fragment.typeCondition?.name.value ?? '',
    fragment.directives?.map((directive) => print(directive)).join(',') ?? '',
  ].join('\0');
}

function mergeInlineFragments(
  existingFragment: InlineFragmentNode,
  nextFragment: InlineFragmentNode
): InlineFragmentNode {
  return {
    ...existingFragment,
    selectionSet: {
      ...existingFragment.selectionSet,
      selections: mergeSelections([
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
      selections: mergeSelections([
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
