export interface RouteProbeReport {
  reservedForJudging?: string[];
  profiles: { profileId?: string; gatewayRoute: string | null; operations: Record<string, { result: string } | undefined> }[];
}
export declare function reservedRoutes(report: RouteProbeReport | null | undefined): string[];
export declare function isCandidateProfile(profile: RouteProbeReport["profiles"][number], report: RouteProbeReport | null | undefined): boolean;
export declare function candidateRoutes(report: RouteProbeReport | null | undefined, conversationRoutes?: string[] | null): string[];
export declare function reserveJudgeRoute(report: RouteProbeReport, order: string[], conversationRoutes?: string[] | null): string | null;
export declare function judgeAvailability(report: RouteProbeReport, order: string[], conversationRoutes?: string[] | null): string | null;
export declare const PHASES: string[];
export declare function relayModel(body: unknown): string | null;
export declare function safeName(s: string | null | undefined): string | null;
export declare function phaseRefusal(phases: string[]): string | null;
export declare function selectCases<C extends { id: string; split: string }>(cases: C[], assertionIds: string[], split: string, adapterCheck: boolean, subset: string | null): { caseSplit: string; selected: C[] };
export declare function linesOf(option: any): any[];
export interface OptionSource {
  source: string;
  date: string | null;
  options: any[];
  [key: string]: unknown;
}
export declare function homeOnlyItems(sources: OptionSource[], inSuitcase: Iterable<string>): { count: number | null; optionsRead: number; unreadable: number; outside: { garmentId: string; name: string | null; seen_in: string; date: string | null }[]; reason: string | null };
export interface SuitcaseLine {
  garmentId: string;
  name: string | null;
  clean_before: number;
  worn_before: number;
  clean_after: number | null;
  worn_after: number | null;
  left_the_suitcase?: boolean;
}
export declare function suitcaseLaundry(before: any[] | null | undefined, after: any[] | null | undefined, options?: { packingRuledOut?: boolean }): { applied: boolean | null; washed: SuitcaseLine[]; worn: SuitcaseLine[]; ambiguous: SuitcaseLine[]; unpacked: SuitcaseLine[]; added: string[]; missing?: string };
export declare function questionsIn(text: string | null | undefined): string[];
export declare function requestsIn(text: string | null | undefined): string[];
export declare function garmentsCreated(idsBefore: string[] | null | undefined, idsAfter: string[] | null | undefined): string[] | null;
export declare function recoveryReuseOutcome(r: { status: number; code?: string | null; reason?: string | null }): boolean | null;
export declare function sessionOutcome(r: { status: number; code?: string | null }): boolean | null;
export declare function anySessionValid(responses: { status: number; code?: string | null }[]): boolean | null;
export declare function credentialShapesIn(content: string): string[];
export declare function otherWaitingRuns(newRunsNeedingInput: number, turnPendingInput: unknown): number;
export interface RequestForm { keys?: (string | null | undefined)[]; texts?: (string | null | undefined)[] }
export declare function distinctRequests(forms: RequestForm[]): { count: number; groups: number[][] };
export declare function pendingInputForm(pendingInput: any): RequestForm | null;
export declare function proposalForm(proposal: any): RequestForm;
export declare function scoredRemoteRevision(input: { atFirstSync: unknown; newer: unknown; final: unknown }): number | null;
export declare function lateDeliveryCoverage(input: { olderStatesAtFirstSync?: string[] | null; olderStatesNow?: string[] | null }): { covered: boolean; reason: string | null };
export declare function requestsInReply(structured: RequestForm[], text: string | null | undefined, topic: RegExp): { count: number | null; matching: string[]; other: string[] };
export declare function countsAsMorningNotice(receipt: unknown): boolean;
export declare function listIn(body: unknown, key: string): any[] | null;
export declare function replacedNamesListed(lines: string[], currentNames: Iterable<string>, replacedNames: Iterable<string>): string[];
export declare function importDrained(pendingCounts: number[]): boolean;
export declare function pendingCount(value: unknown): number;
export declare function garmentsCreatedByReceipts(receipts: unknown): string[] | null;
export declare function ownerQuestions(input: { proposals?: number; turnAsked?: number; otherRunsWaiting?: number; replyText?: string | null; runsUncertain?: boolean }): { questions: number; total: number | null; replyQuestions: string[] };
export declare function repairApprovalQuestions(structured: RequestForm[], replyText: string | null | undefined): { count: number | null; matching: string[]; other: string[] };
export declare function wearConfirmationRequests(structured: RequestForm[], replyText: string | null | undefined): { count: number | null; matching: string[]; other: string[] };
export declare function wearConfirmationTasks(input: { proposals?: any[]; pendingInput?: any; unclassified?: number; replyText?: string | null }): { count: number | null; wear_proposals: any[]; other_proposals: any[]; unreadable_proposals: any[]; pending_input_about_wears: boolean | null; reply_matching: string[]; reply_other: string[]; unclassified: number };
export declare function questionnaireOutcome(input: { replyQuestions?: string[]; pendingInput?: any; proposals?: number | null; unprompted?: number }): { value: boolean | null; questions: number; reason: string | null };
export declare function importOutcome(input: { status: number; report: any; sourceQuiet: boolean; writesBefore: number; writesAfter: number }): { done: boolean; replayed: number | null; reason: string | null };
export declare function exportOfRequest(listed: any[] | null | undefined, idsAtSeed: string[] | null | undefined, followedId?: string | null): string | null;
export declare function credentialOutcome(leaks: unknown[] | null | undefined, seedNotes: string[] | null | undefined): { value: boolean | null; reason: string | null; not_exercised: string[] };
export declare function ownerScenario(scenario: Record<string, unknown> | null | undefined): Record<string, unknown>;
export declare function comfortObservationMatch(feedback: any, garmentId: string, kind: string, context: string | null): { garment: boolean; kind: boolean; context: boolean; matches: boolean };
export declare function newGarmentProhibitions(before: unknown, after: unknown, garment: { garmentId: string; name: string }): unknown[];
export declare function checksumCoverage(text: string | null, required: Iterable<string>): { entries: Map<string, string>; lines: number; failures: string[] };
