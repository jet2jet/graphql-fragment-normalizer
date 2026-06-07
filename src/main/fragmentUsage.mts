import {
  Kind,
  visit,
  type DefinitionNode,
  type DocumentNode,
  type FragmentDefinitionNode,
} from 'graphql';
import type { FragmentDefinitionsMode } from './expandFragmentsTypes.mts';
import { shouldExpandOperation } from './operationUtils.mts';

export function collectPreservedFragmentNames(
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  definitions: readonly DefinitionNode[],
  preserveNamedFragmentsUsedAtLeast: number
): ReadonlySet<string> {
  if (preserveNamedFragmentsUsedAtLeast <= 0) {
    return new Set();
  }

  const spreadCounts = collectFragmentSpreadCounts(definitions, fragments);
  const preservedFragmentNames = new Set<string>();

  for (const [fragmentName, spreadCount] of spreadCounts) {
    if (
      spreadCount >= preserveNamedFragmentsUsedAtLeast &&
      fragments.has(fragmentName)
    ) {
      preservedFragmentNames.add(fragmentName);
    }
  }

  // Retained definitions are intentionally left unnormalized. Any fragments they
  // reference must also be emitted, even if those fragments are below the threshold.
  const pendingFragmentNames = [...preservedFragmentNames];
  for (let index = 0; index < pendingFragmentNames.length; index += 1) {
    const fragment = fragments.get(pendingFragmentNames[index]!);
    if (!fragment) {
      continue;
    }

    for (const spreadName of collectFragmentSpreadNames(fragment)) {
      if (
        preservedFragmentNames.has(spreadName) ||
        !fragments.has(spreadName)
      ) {
        continue;
      }

      preservedFragmentNames.add(spreadName);
      pendingFragmentNames.push(spreadName);
    }
  }

  return preservedFragmentNames;
}

export function getFragmentPreservationRoots(
  document: DocumentNode,
  fragmentDefinitionsMode: FragmentDefinitionsMode,
  operationName: string | null
): readonly DefinitionNode[] {
  return document.definitions.filter((definition) => {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      return shouldExpandOperation(definition, operationName);
    }

    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      return fragmentDefinitionsMode === 'normalize';
    }

    return false;
  });
}

function collectFragmentSpreadCounts(
  definitions: readonly DefinitionNode[],
  fragments: ReadonlyMap<string, FragmentDefinitionNode>
): ReadonlyMap<string, number> {
  const spreadCounts = new Map<string, number>();
  const visitedFragmentNames = new Set<string>();

  const countSpread = (fragmentName: string): void => {
    spreadCounts.set(fragmentName, (spreadCounts.get(fragmentName) ?? 0) + 1);

    const fragment = fragments.get(fragmentName);
    if (!fragment || visitedFragmentNames.has(fragmentName)) {
      return;
    }

    visitedFragmentNames.add(fragmentName);
    visitDefinition(fragment);
  };

  const visitDefinition = (definition: DefinitionNode): void => {
    visit(definition, {
      FragmentSpread(fragmentSpread) {
        countSpread(fragmentSpread.name.value);
      },
    });
  };

  for (const definition of definitions) {
    visitDefinition(definition);
  }

  return spreadCounts;
}

function collectFragmentSpreadNames(
  fragment: FragmentDefinitionNode
): readonly string[] {
  const spreadNames: string[] = [];

  visit(fragment, {
    FragmentSpread(fragmentSpread) {
      spreadNames.push(fragmentSpread.name.value);
    },
  });

  return spreadNames;
}
