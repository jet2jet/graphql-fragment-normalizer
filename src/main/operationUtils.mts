import type {
  GraphQLObjectType,
  GraphQLSchema,
  OperationDefinitionNode,
} from 'graphql';

export function shouldExpandOperation(
  definition: OperationDefinitionNode,
  operationName: string | null
): boolean {
  if (operationName == null) {
    return true;
  }

  return definition.name?.value === operationName;
}

export function getOperationRootType(
  schema: GraphQLSchema,
  definition: OperationDefinitionNode
): GraphQLObjectType | undefined {
  switch (definition.operation) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    case 'query':
      return schema.getQueryType() ?? undefined;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    case 'mutation':
      return schema.getMutationType() ?? undefined;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    case 'subscription':
      return schema.getSubscriptionType() ?? undefined;

    default:
      return throwUnexpectedOperation(definition.operation satisfies never);
  }
}

function throwUnexpectedOperation(operation: never): never {
  throw new Error(`Unexpected operation type: ${String(operation)}`);
}
