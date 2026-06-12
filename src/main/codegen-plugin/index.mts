import type { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { Kind, type FragmentDefinitionNode, type GraphQLSchema } from 'graphql';
import createTypeRelationContext, {
  type TypeRelationContext,
} from '../createTypeRelationContext.mts';
import expandFragments, {
  type ExpandFragmentsOptions,
} from '../expandFragments.mts';

export type Config = Omit<
  ExpandFragmentsOptions,
  'additionalFragments' | 'fragmentDefinitionsMode' | 'typeRelationContext'
> & {
  readonly externalFragments?: readonly ExternalFragment[];
};

interface ExternalFragment {
  readonly name?: string;
  readonly onType?: string;
  readonly node: FragmentDefinitionNode;
  readonly isExternal?: boolean;
  readonly importFrom?: string | null;
}

const typeRelationContexts = new WeakMap<GraphQLSchema, TypeRelationContext>();

export const plugin: PluginFunction<Config> = (schema, documents, config) => {
  const typeRelationContext = getTypeRelationContext(schema);
  const additionalFragments = collectAdditionalFragmentDefinitions(
    documents,
    config.externalFragments
  );
  documents.forEach((documentFile) => {
    if (!documentFile.document) {
      return;
    }

    const document = expandFragments(schema, documentFile.document, {
      ...config,
      additionalFragments,
      fragmentDefinitionsMode: 'preserve',
      typeRelationContext,
    });

    // Change document in-place
    documentFile.document = document;
  });

  // This plugin itself does not have any outputs (the following plugins should output something with using modified documents)
  return {
    content: '',
  };
};

function collectAdditionalFragmentDefinitions(
  documents: readonly Types.DocumentFile[],
  externalFragments: readonly ExternalFragment[] | undefined
): FragmentDefinitionNode[] {
  return [
    ...(externalFragments?.map((fragment) => fragment.node) ?? []),
    ...collectFragmentDefinitions(documents),
  ];
}

function getTypeRelationContext(schema: GraphQLSchema): TypeRelationContext {
  const cachedContext = typeRelationContexts.get(schema);
  if (cachedContext) {
    return cachedContext;
  }

  const context = createTypeRelationContext(schema);
  typeRelationContexts.set(schema, context);
  return context;
}

function collectFragmentDefinitions(
  documents: readonly Types.DocumentFile[]
): FragmentDefinitionNode[] {
  return documents.flatMap((documentFile) => {
    const document = documentFile.document;
    if (!document) {
      return [];
    }

    return document.definitions.filter(
      (definition): definition is FragmentDefinitionNode =>
        definition.kind === Kind.FRAGMENT_DEFINITION
    );
  });
}
