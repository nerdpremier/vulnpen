import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequireHostOwner,
  isHostOwner,
} from "../src/services/host-owner.service";
import {
  type ProviderConfig,
  resolveInvocationProvider,
  restrictHostSubscriptionModels,
} from "../src/utils/llm/providers";

test("the installation owner can use host-global resources", async () => {
  assert.equal(await isHostOwner("owner-id", async () => "owner-id"), true);
});

test("an ordinary registered user cannot use host-global resources", async () => {
  assert.equal(await isHostOwner("other-id", async () => "owner-id"), false);
});

function responseFor(userId: string) {
  const result = {
    locals: { userId },
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return result;
}

test("host-owner middleware admits the owner and rejects an ordinary user", async () => {
  const middleware = createRequireHostOwner(async () => "owner-id");
  const ownerResponse = responseFor("owner-id");
  const userResponse = responseFor("other-id");
  let ownerNext = false;
  let userNext = false;

  await middleware({} as any, ownerResponse as any, () => {
    ownerNext = true;
  });
  await middleware({} as any, userResponse as any, () => {
    userNext = true;
  });

  assert.equal(ownerNext, true);
  assert.equal(userNext, false);
  assert.equal(userResponse.statusCode, 403);
});

const apiModel = {
  id: "api",
  label: "API model",
  provider: "openai",
  model: "gpt-5",
};
const subscriptionModel = {
  id: "subscription",
  label: "Host subscription",
  provider: "codex-subscription",
  model: "gpt-5-codex",
};

test("runtime rejects a subscription orchestrator for a non-owner", () => {
  assert.throws(
    () =>
      restrictHostSubscriptionModels(
        {
          orchestrator: subscriptionModel,
          all: [subscriptionModel],
        },
        false,
      ),
    /reserved for the installation owner/,
  );
});

test("runtime filters subscription models from all for a non-owner", () => {
  const result = restrictHostSubscriptionModels(
    {
      orchestrator: apiModel,
      all: [apiModel, subscriptionModel],
    },
    false,
  );

  assert.deepEqual(result.all, [apiModel]);
});

test("runtime preserves host subscription models for the owner", () => {
  const models = {
    orchestrator: subscriptionModel,
    all: [subscriptionModel],
  };

  assert.equal(restrictHostSubscriptionModels(models, true), models);
});

const hostSubscription: ProviderConfig = {
  provider: "codex-subscription",
  apiKey: "",
  model: "gpt-5.6-sol",
};

test("invocation boundary rejects an explicit host subscription override for a non-owner", async () => {
  await assert.rejects(
    resolveInvocationProvider(
      { providerOverride: hostSubscription, userId: "ordinary-user" },
      async () => false,
    ),
    /reserved for the installation owner/,
  );
});

test("invocation boundary rejects a default host subscription for a non-owner", async () => {
  await assert.rejects(
    resolveInvocationProvider(
      { userId: "ordinary-user" },
      async () => false,
      async () => hostSubscription,
    ),
    /reserved for the installation owner/,
  );
});

test("invocation boundary permits the owner and leaves API providers unchanged", async () => {
  assert.equal(
    await resolveInvocationProvider(
      { providerOverride: hostSubscription, userId: "owner-id" },
      async () => true,
    ),
    hostSubscription,
  );

  let checkedOwnership = false;
  const apiProvider: ProviderConfig = {
    provider: "openai",
    apiKey: "key",
    model: "gpt-5",
  };
  assert.equal(
    await resolveInvocationProvider(
      { providerOverride: apiProvider, userId: "ordinary-user" },
      async () => {
        checkedOwnership = true;
        return false;
      },
    ),
    apiProvider,
  );
  assert.equal(checkedOwnership, false);
});
