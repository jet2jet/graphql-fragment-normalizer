import {
  isCompositeType,
  type DefinitionNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
} from 'graphql';
import type { ResolvedExpandFragmentsOptions } from './expandFragmentsTypes.mts';
import { expandSelectionSet } from './selectionExpander.mts';

export function pushFragmentDefinition(
  schema: GraphQLSchema,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  definition: FragmentDefinitionNode,
  options: ResolvedExpandFragmentsOptions,
  definitions: DefinitionNode[],
  emittedFragmentDefinitionNames: Set<string>
): void {
  if (options.preservedFragmentNames.has(definition.name.value)) {
    // A spread that remains in the output must keep its colocated fragment shape.
    definitions.push(definition);
    emittedFragmentDefinitionNames.add(definition.name.value);
    return;
  }

  switch (options.fragmentDefinitionsMode) {
    case 'drop':
      return;

    case 'preserve':
      definitions.push(definition);
      emittedFragmentDefinitionNames.add(definition.name.value);
      return;

    case 'normalize': {
      const type = schema.getType(definition.typeCondition.name.value);
      if (!isCompositeType(type)) {
        definitions.push(definition);
        emittedFragmentDefinitionNames.add(definition.name.value);
        return;
      }

      definitions.push({
        ...definition,
        selectionSet: expandSelectionSet(
          schema,
          fragments,
          definition.selectionSet,
          type,
          [definition.name.value],
          options
        ),
      });
      emittedFragmentDefinitionNames.add(definition.name.value);
      return;
    }

    default:
      throwUnexpectedFragmentDefinitionsMode(
        options.fragmentDefinitionsMode satisfies never
      );
  }
}

export function pushRetainedAdditionalFragmentDefinitions(
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  options: ResolvedExpandFragmentsOptions,
  definitions: DefinitionNode[],
  emittedFragmentDefinitionNames: Set<string>
): void {
  for (const fragmentName of options.preservedFragmentNames) {
    if (emittedFragmentDefinitionNames.has(fragmentName)) {
      continue;
    }

    const definition = fragments.get(fragmentName);
    if (!definition) {
      continue;
    }

    definitions.push(definition);
    emittedFragmentDefinitionNames.add(fragmentName);
  }
}

function throwUnexpectedFragmentDefinitionsMode(mode: never): never {
  throw new Error(`Unexpected fragment definitions mode: ${String(mode)}`);
}
