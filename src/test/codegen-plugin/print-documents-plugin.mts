import type { PluginFunction } from '@graphql-codegen/plugin-helpers';
import { print } from 'graphql';

export const plugin: PluginFunction = (_schema, documents) => {
  return {
    content: documents
      .flatMap((documentFile) => documentFile.document?.definitions ?? [])
      .map((definition) => print(definition))
      .join('\n\n'),
  };
};
