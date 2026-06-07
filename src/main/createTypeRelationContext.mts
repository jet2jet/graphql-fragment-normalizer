import {
  doTypesOverlap,
  type GraphQLCompositeType,
  type GraphQLInterfaceType,
  type GraphQLSchema,
} from 'graphql';

/** Used by `expandFragments` to calculate type relations. Can be created by using {@linkcode createTypeRelationContext}. */
export interface TypeRelationContext {
  readonly doesOverlap: (
    typeA: GraphQLCompositeType,
    typeB: GraphQLCompositeType
  ) => boolean;
  readonly interfaceImplements: (
    parentType: GraphQLInterfaceType,
    conditionType: GraphQLInterfaceType
  ) => boolean;
}

/**
 * Creates {@linkcode TypeRelationContext} instance for calculating type relations.
 * This instance should always returns same result for same `schema`, so you can re-use
 * if `schema` is unchanged.
 */
export default function createTypeRelationContext(
  schema: GraphQLSchema
): TypeRelationContext {
  // Type overlap checks may inspect possible concrete types for interfaces and unions.
  // Fragment expansion tends to ask about the same type pairs repeatedly, so memoize
  // per expandFragments call without building a schema-wide relationship table up front.
  const overlapCache = new Map<string, boolean>();
  const interfaceImplementationCache = new Map<string, boolean>();

  return {
    doesOverlap(typeA, typeB) {
      const key = getUnorderedTypePairKey(typeA, typeB);
      const cachedResult = overlapCache.get(key);
      if (cachedResult != null) {
        return cachedResult;
      }

      const result = doTypesOverlap(schema, typeA, typeB);
      overlapCache.set(key, result);
      return result;
    },

    interfaceImplements(parentType, conditionType) {
      const key = getOrderedTypePairKey(parentType, conditionType);
      const cachedResult = interfaceImplementationCache.get(key);
      if (cachedResult != null) {
        return cachedResult;
      }

      const result = parentType.getInterfaces().some((implementedInterface) => {
        if (implementedInterface.name === conditionType.name) {
          return true;
        }

        return this.interfaceImplements(implementedInterface, conditionType);
      });

      interfaceImplementationCache.set(key, result);
      return result;
    },
  };
}

function getUnorderedTypePairKey(
  typeA: GraphQLCompositeType,
  typeB: GraphQLCompositeType
): string {
  return typeA.name < typeB.name
    ? getOrderedTypePairKey(typeA, typeB)
    : getOrderedTypePairKey(typeB, typeA);
}

function getOrderedTypePairKey(
  typeA: GraphQLCompositeType,
  typeB: GraphQLCompositeType
): string {
  return `${typeA.name}\0${typeB.name}`;
}
