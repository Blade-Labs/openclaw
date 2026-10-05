import type { ApprovalResolvingActor } from "../../infra/approval-requester-binding.js";

export type AdmittedChannelActor = Readonly<{ kind: "admitted-channel-actor" }>;
type ChannelActor = Extract<ApprovalResolvingActor, { kind: "channel" }>;

class Actor implements AdmittedChannelActor {
  readonly kind = "admitted-channel-actor";
  #actor: ChannelActor;
  #assertCurrent: () => void;
  constructor(actor: ChannelActor, assertCurrent: () => void) {
    this.#actor = Object.freeze({ ...actor });
    this.#assertCurrent = assertCurrent;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static read(
    value: AdmittedChannelActor,
  ): { actor: ChannelActor; assertCurrent: () => void } | undefined {
    if (!value || typeof value !== "object" || !(#actor in value)) {
      return undefined;
    }
    value.#assertCurrent();
    return { actor: value.#actor, assertCurrent: value.#assertCurrent };
  }
}

/** Called by authenticated event admission under the source account's live owner. */
export function admitChannelApprovalActor(
  actor: ChannelActor,
  assertCurrent: () => void,
): AdmittedChannelActor {
  assertCurrent();
  return new Actor(actor, assertCurrent);
}

export function readAdmittedChannelApprovalActor(value: AdmittedChannelActor) {
  return Actor.read(value);
}
