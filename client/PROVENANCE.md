# Browser source provenance

The minimal browser client adapts the experimental host behaviour from `ts-client` commit `0106096d9b4b0bb6e8f670f237b646622bd0d425` and uses the revised EarShot voice code. This commit is the best-supported source candidate for the August 25 pilot; the exact browser bundles used in the earlier recordings were not recorded. New captures retain a build manifest and both endpoints' build IDs.

The [client README](README.md) describes the retained host behaviour and experimental limits. The [machine-readable comparison](provenance.json) retains source identifiers, file hashes and the comparison with the EarShot artifact.

To regenerate the comparison, run `node tools/audit-client-source.cjs SOURCE_CHECKOUT` from this repository's root, replacing `SOURCE_CHECKOUT` with a readable source checkout. The script reads that checkout without modifying it and writes `client/provenance.json` here.
