# Changelog

## v0.3.1

(Fix around build error only; no implementations changed)

## v0.3.0

Update dependencies; now supports graphql@17

## v0.2.6

(Fix around build error only; no implementations changed)

## v0.2.5

- (**Possibly breaking change** but is actual a bugfix) Fix to throw (by default) on unresolved named fragment spreads instead of silently dropping them
- Fix codegen plugin external fragment expansion

## v0.2.4

- Normalize nested concrete fragment branches

## v0.2.3

- Deduplicate branch fields covered by parent selections

## v0.2.2

(Fix around CI only; no implementations changed)

## v0.2.1

(Fix around CI only; no implementations changed)

## v0.2.0

- Prune impossible fragment branches through abstract type scopes
- Add option (`distributeAbstractFragments`) to expand fragments for each reachable concrete object type
- Remove unnecessary 'engines' section from package.json
- Wide `@graphql-codegen/plugin-helpers` peerDependency version

## v0.1.0

Initial version.
