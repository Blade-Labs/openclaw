import {
  createDefaultAdmissionTurnSource,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionFacts } from "../../audit/execution-identity-admission.js";
import {
  consumeChannelAdmissionEvidence,
  recordChannelAdmissionDecision,
  type ChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { projectHostTurnSource, type HostTurnSource } from "../../infra/host-turn-source.js";

/** Adapt one opaque channel carrier to the canonical admitted-run facts and decision FIFO. */
export function consumeChannelRunAdmission(evidence: ChannelAdmissionEvidence | undefined): {
  ingressState: ExecutionIdentityAdmissionFacts["ingress"]["state"];
  facts: Pick<ExecutionIdentityAdmissionFacts, "invoker" | "assurance">;
  onAdmitted: (context: AdmittedRunContext) => void;
} {
  const admission = consumeChannelAdmissionEvidence(evidence);
  return Object.freeze({
    ingressState: admission.ingressState,
    facts: Object.freeze({
      invoker: admission.invoker,
      ...(admission.assuranceRef
        ? {
            assurance: [
              {
                kind: "channel-admission" as const,
                rawEvidenceRef: admission.assuranceRef,
                // Core verified the registered record/epoch/scope handoff; the
                // native plugin remains the remote participant-fact producer.
                strength: "boundary-verified" as const,
              },
            ],
          }
        : {}),
    }),
    onAdmitted: (context) => {
      const token = context.executionIdentityToken;
      if (token && admission.decisionCoverage && admission.identifierAuthentication) {
        recordChannelAdmissionDecision(evidence, {
          contextId: token.contextId,
          executionId: token.executionId,
          runId: token.runId,
          occurredAt: token.createdAt,
          coverageState: admission.decisionCoverage,
          identifierAuthentication: admission.identifierAuthentication,
        });
      }
    },
  });
}

/** Defer evidence consumption until the selected runtime actually admits the run. */
export function prepareChannelRunAdmission(params: {
  turnSource?: HostTurnSource;
  sessionKey?: string;
  cfg: OpenClawConfig;
  runId: string;
  agentId: string;
  ingressKind: ExecutionIdentityAdmissionFacts["ingress"]["kind"];
  boundary: string;
  evidence?: ChannelAdmissionEvidence;
  assertSourceCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  onAdmitted?: (context: AdmittedRunContext) => void;
}): PreparedAgentRunAdmission {
  const operationalRunInstance = createOperationalRunInstanceRef(params.runId);
  // Normalized once: readSource() before admission and the admitted context
  // project the same source, including the non-user fallback.
  const turnSource = params.turnSource ?? createDefaultAdmissionTurnSource(params.ingressKind);
  let prepared: PreparedAgentRunAdmission | undefined;
  let closed = false;
  const assertSourceCurrent = () => {
    if (prepared) {
      prepared.assertSourceCurrent();
      return;
    }
    params.assertSourceCurrent?.();
    params.operatorAuthority?.assertCurrent();
  };
  return Object.freeze({
    operationalRunInstance,
    assertSourceCurrent,
    readSource: () =>
      prepared?.readSource?.() ??
      projectHostTurnSource(
        closed ? undefined : turnSource,
        operationalRunInstance.runId,
        params.sessionKey ?? null,
        0,
      ),
    readOperatorAuthority: () => {
      if (closed && params.operatorAuthority) {
        throw new Error("prepared operator authority is no longer active");
      }
      assertSourceCurrent();
      return params.operatorAuthority;
    },
    admit: (runtimeKind, runtimeInstanceId) => {
      if (closed) {
        return Promise.reject(new Error("prepared execution context is already closed"));
      }
      if (!prepared) {
        const channelAdmission = consumeChannelRunAdmission(params.evidence);
        prepared = prepareAgentRunAdmission({
          cfg: params.cfg,
          assertSourceCurrent: params.assertSourceCurrent,
          operationalRunInstance,
          operatorAuthority: params.operatorAuthority,
          turnSource,
          sessionKey: params.sessionKey,
          facts: {
            runId: params.runId,
            agentId: params.agentId,
            ingress: {
              kind: params.ingressKind,
              boundary: params.boundary,
              state: channelAdmission.ingressState,
            },
            ...channelAdmission.facts,
          },
          onAdmitted: (context) => {
            channelAdmission.onAdmitted(context);
            params.onAdmitted?.(context);
          },
        });
      }
      return prepared.admit(runtimeKind, runtimeInstanceId);
    },
    close: () => {
      closed = true;
      prepared?.close();
    },
  });
}
