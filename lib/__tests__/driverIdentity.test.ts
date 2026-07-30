import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDisplayName,
  syncProviderDriverName,
  type IdentityMappingClient,
  type IdentityDriverClient,
} from "../driverIdentity";

// ---------------------------------------------------------------------------
// resolveDisplayName — preferred order: canonicalName > Telegram first+last >
// Telegram username > generic fallback (Phase 4.6, Part E).
// ---------------------------------------------------------------------------

describe("resolveDisplayName", () => {
  test("canonicalName wins when present, even if Telegram fields are also present", () => {
    const name = resolveDisplayName({
      canonicalName: "John Smith",
      telegramFirstName: "Johnny",
      telegramLastName: "S",
      telegramUsername: "johnny_s",
    });
    assert.equal(name, "John Smith");
  });

  test("falls back to Telegram first + last name when canonicalName is absent", () => {
    const name = resolveDisplayName({
      canonicalName: null,
      telegramFirstName: "Johnny",
      telegramLastName: "S",
      telegramUsername: "johnny_s",
    });
    assert.equal(name, "Johnny S");
  });

  test("falls back to first name only when last name is missing", () => {
    const name = resolveDisplayName({ telegramFirstName: "Johnny", telegramUsername: "johnny_s" });
    assert.equal(name, "Johnny");
  });

  test("falls back to @username when no name is available at all", () => {
    const name = resolveDisplayName({ telegramUsername: "johnny_s" });
    assert.equal(name, "@johnny_s");
  });

  test("falls back to generic 'Driver' label when nothing is available", () => {
    assert.equal(resolveDisplayName({}), "Driver");
  });

  test("a whitespace-only canonicalName is treated as absent, not a real name", () => {
    const name = resolveDisplayName({ canonicalName: "   ", telegramFirstName: "Johnny" });
    assert.equal(name, "Johnny");
  });

  test("a whitespace-only Telegram name falls through to username", () => {
    const name = resolveDisplayName({
      telegramFirstName: "  ",
      telegramLastName: "  ",
      telegramUsername: "johnny_s",
    });
    assert.equal(name, "@johnny_s");
  });

  test("username is never shown alongside a real name (no 'Name @handle' combination)", () => {
    const name = resolveDisplayName({ telegramFirstName: "Johnny", telegramUsername: "johnny_s" });
    assert.equal(name, "Johnny");
  });
});

// ---------------------------------------------------------------------------
// syncProviderDriverName — idempotent provider → SafeHaul canonicalName sync
// (Phase 4.6, Part D). Fully faked, no real prisma/network access.
// ---------------------------------------------------------------------------

interface FakeMappingRow {
  id: string;
  driverId: string;
  providerDriverName: string | null;
}
interface FakeDriverRow {
  id: string;
  canonicalName: string | null;
}

function makeFakes(mappingRow: FakeMappingRow | null, driverRow: FakeDriverRow | undefined) {
  const mappings = new Map<string, FakeMappingRow>();
  const drivers = new Map<string, FakeDriverRow>();
  if (mappingRow) mappings.set(mappingRow.id, mappingRow);
  if (driverRow) drivers.set(driverRow.id, driverRow);

  const mappingUpdateCalls: { id: string; providerDriverName: string }[] = [];
  const driverUpdateCalls: { id: string; canonicalName: string }[] = [];

  const mappingClient: IdentityMappingClient = {
    findUnique: async ({ where }) => {
      const { externalDriverId } = where.provider_externalDriverId;
      const row = Array.from(mappings.values()).find((m) => m.id === externalDriverId) ?? null;
      if (!row) return null;
      const driver = drivers.get(row.driverId);
      return {
        id: row.id,
        driverId: row.driverId,
        providerDriverName: row.providerDriverName,
        driver: { canonicalName: driver?.canonicalName ?? null },
      };
    },
    update: async ({ where, data }) => {
      mappingUpdateCalls.push({ id: where.id, providerDriverName: data.providerDriverName });
      const row = mappings.get(where.id);
      if (row) row.providerDriverName = data.providerDriverName;
      return {};
    },
  };

  const driverClient: IdentityDriverClient = {
    update: async ({ where, data }) => {
      driverUpdateCalls.push({ id: where.id, canonicalName: data.canonicalName });
      const row = drivers.get(where.id);
      if (row) row.canonicalName = data.canonicalName;
      return {};
    },
  };

  const runTransaction = async (ops: Promise<unknown>[]) => Promise.all(ops);

  return { mappingClient, driverClient, runTransaction, mappingUpdateCalls, driverUpdateCalls, mappings, drivers };
}

describe("syncProviderDriverName", () => {
  test("no mapping found → no-op, no writes", async () => {
    const fakes = makeFakes(null, undefined);
    await syncProviderDriverName("samsara", "ext-1", "Jane Doe", fakes);
    assert.equal(fakes.mappingUpdateCalls.length, 0);
    assert.equal(fakes.driverUpdateCalls.length, 0);
  });

  test("empty/whitespace name → no-op, mapping is never even looked up", async () => {
    let findUniqueCalled = false;
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: null },
      { id: "drv-1", canonicalName: null }
    );
    const wrappedMappingClient: IdentityMappingClient = {
      ...fakes.mappingClient,
      findUnique: async (args) => {
        findUniqueCalled = true;
        return fakes.mappingClient.findUnique(args);
      },
    };
    await syncProviderDriverName("samsara", "ext-1", "   ", { ...fakes, mappingClient: wrappedMappingClient });
    assert.equal(findUniqueCalled, false);
    assert.equal(fakes.mappingUpdateCalls.length, 0);
  });

  test("null/undefined name → no-op", async () => {
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: null },
      { id: "drv-1", canonicalName: null }
    );
    await syncProviderDriverName("samsara", "ext-1", null, fakes);
    await syncProviderDriverName("samsara", "ext-1", undefined, fakes);
    assert.equal(fakes.mappingUpdateCalls.length, 0);
    assert.equal(fakes.driverUpdateCalls.length, 0);
  });

  test("first-time sync: mapping has no providerDriverName yet → sets both mapping and canonicalName", async () => {
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: null },
      { id: "drv-1", canonicalName: null }
    );
    await syncProviderDriverName("samsara", "ext-1", "Jane Doe", fakes);
    assert.deepEqual(fakes.mappingUpdateCalls, [{ id: "ext-1", providerDriverName: "Jane Doe" }]);
    assert.deepEqual(fakes.driverUpdateCalls, [{ id: "drv-1", canonicalName: "Jane Doe" }]);
  });

  test("renamed provider driver: incoming name differs from stored providerDriverName → updates both", async () => {
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: "Jane Doe" },
      { id: "drv-1", canonicalName: "Jane Doe" }
    );
    await syncProviderDriverName("samsara", "ext-1", "Jane Smith", fakes);
    assert.deepEqual(fakes.mappingUpdateCalls, [{ id: "ext-1", providerDriverName: "Jane Smith" }]);
    assert.deepEqual(fakes.driverUpdateCalls, [{ id: "drv-1", canonicalName: "Jane Smith" }]);
  });

  test("duplicate synchronization: same name synced twice in a row → second call is a no-op", async () => {
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: null },
      { id: "drv-1", canonicalName: null }
    );
    await syncProviderDriverName("samsara", "ext-1", "Jane Doe", fakes);
    await syncProviderDriverName("samsara", "ext-1", "Jane Doe", fakes);
    assert.equal(fakes.mappingUpdateCalls.length, 1);
    assert.equal(fakes.driverUpdateCalls.length, 1);
  });

  test("leading/trailing whitespace in the incoming name is trimmed before comparing and storing", async () => {
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: "Jane Doe" },
      { id: "drv-1", canonicalName: "Jane Doe" }
    );
    await syncProviderDriverName("samsara", "ext-1", "  Jane Doe  ", fakes);
    assert.equal(fakes.mappingUpdateCalls.length, 0);
    assert.equal(fakes.driverUpdateCalls.length, 0);
  });

  test("mapping.providerDriverName matches but canonicalName has diverged → still resyncs canonicalName", async () => {
    const fakes = makeFakes(
      { id: "ext-1", driverId: "drv-1", providerDriverName: "Jane Doe" },
      { id: "drv-1", canonicalName: "Some Other Value" }
    );
    await syncProviderDriverName("samsara", "ext-1", "Jane Doe", fakes);
    assert.deepEqual(fakes.driverUpdateCalls, [{ id: "drv-1", canonicalName: "Jane Doe" }]);
  });
});
