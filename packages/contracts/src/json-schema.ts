import { z } from 'zod';
import { Garment, GarmentAlias, AliasResolution } from './garment.js';
import { DailyWear, LaundryBatch, Restriction, StockBalance, WearObservation, LaundryRoutine } from './stock.js';
import { Board, OutfitOption, Selection } from './board.js';
import { BoardDocument } from './board-document.js';
import { CommandEnvelope, DomainCommand } from './commands.js';
import { CommandReceipt } from './receipt.js';
import { AvailabilityEstimate, EstimatorParameters } from './estimator.js';
import { ImportDataset } from './import.js';
import { StyleDocument, StyleRule, StyleRuleCatalogue } from './style.js';
import {
  ApiError,
  AssistantGrant,
  CancelRunResponse,
  ConnectionsResponse,
  ConversationPage,
  DisconnectResponse,
  ItemDetail,
  LaundryState,
  NativeTokenResponse,
  ReceiptsPage,
  RecallSearchRequest,
  RecallSearchResponse,
  RegisterConnectionRequest,
  RunEvent,
  RunStatus,
  SessionResponse,
  SettingsResponse,
  StyleCurrentResponse,
  TemperaturePreview,
  TodayResponse,
  TurnRequest,
  TurnResponse,
  WardrobePage,
  WardrobeQueryParams,
} from './api.js';
import {
  CompositionManifest,
  GarmentMedia,
  MediaAsset,
  OutfitComposite,
  PhotosNeeded,
  SavedCombination,
  StudioChoices,
  StudioChoicesRequest,
  StudioSuggestion,
  StudioSuggestRequest,
  StudioValidateRequest,
  StudioValidation,
  UploadAuthorization,
  UploadCompleteResponse,
  UploadRequest,
} from './visual.js';
import * as S from './surface.js';

/**
 * Schemas exported as JSON Schema (draft 2020-12) for the iOS app and MCP tool definitions.
 * `io: 'input'` documents what a client may send; `io: 'output'` what the server returns.
 */
export const JSON_SCHEMA_EXPORTS: Record<string, { schema: z.ZodType; io: 'input' | 'output' }> = {
  CommandEnvelope: { schema: CommandEnvelope, io: 'input' },
  DomainCommand: { schema: DomainCommand, io: 'input' },
  ImportDataset: { schema: ImportDataset, io: 'input' },
  CommandReceipt: { schema: CommandReceipt, io: 'output' },
  Garment: { schema: Garment, io: 'output' },
  GarmentAlias: { schema: GarmentAlias, io: 'output' },
  AliasResolution: { schema: AliasResolution, io: 'output' },
  StockBalance: { schema: StockBalance, io: 'output' },
  Restriction: { schema: Restriction, io: 'output' },
  WearObservation: { schema: WearObservation, io: 'output' },
  DailyWear: { schema: DailyWear, io: 'output' },
  LaundryBatch: { schema: LaundryBatch, io: 'output' },
  LaundryRoutine: { schema: LaundryRoutine, io: 'output' },
  Board: { schema: Board, io: 'output' },
  BoardDocument: { schema: BoardDocument, io: 'output' },
  OutfitOption: { schema: OutfitOption, io: 'output' },
  Selection: { schema: Selection, io: 'output' },
  AvailabilityEstimate: { schema: AvailabilityEstimate, io: 'output' },
  EstimatorParameters: { schema: EstimatorParameters, io: 'output' },
  WardrobePage: { schema: WardrobePage, io: 'output' },
  ItemDetail: { schema: ItemDetail, io: 'output' },
  TodayResponse: { schema: TodayResponse, io: 'output' },
  SettingsResponse: { schema: SettingsResponse, io: 'output' },
  ApiError: { schema: ApiError, io: 'output' },
  RunEvent: { schema: RunEvent, io: 'output' },
  StyleCurrentResponse: { schema: StyleCurrentResponse, io: 'output' },
  AssistantGrant: { schema: AssistantGrant, io: 'output' },
  ConnectionsResponse: { schema: ConnectionsResponse, io: 'output' },
  RegisterConnectionRequest: { schema: RegisterConnectionRequest, io: 'input' },
  DisconnectResponse: { schema: DisconnectResponse, io: 'output' },
  ReceiptsPage: { schema: ReceiptsPage, io: 'output' },
  WardrobeQueryParams: { schema: WardrobeQueryParams, io: 'input' },
  LaundryState: { schema: LaundryState, io: 'output' },
  TemperaturePreview: { schema: TemperaturePreview, io: 'output' },
  TurnRequest: { schema: TurnRequest, io: 'input' },
  TurnResponse: { schema: TurnResponse, io: 'output' },
  ConversationPage: { schema: ConversationPage, io: 'output' },
  RecallSearchRequest: { schema: RecallSearchRequest, io: 'input' },
  RecallSearchResponse: { schema: RecallSearchResponse, io: 'output' },
  RunStatus: { schema: RunStatus, io: 'output' },
  CancelRunResponse: { schema: CancelRunResponse, io: 'output' },
  NativeTokenResponse: { schema: NativeTokenResponse, io: 'output' },
  SessionResponse: { schema: SessionResponse, io: 'output' },
  StyleDocument: { schema: StyleDocument, io: 'output' },
  StyleRule: { schema: StyleRule, io: 'output' },
  StyleRuleCatalogue: { schema: StyleRuleCatalogue, io: 'input' },
  MediaAsset: { schema: MediaAsset, io: 'output' },
  GarmentMedia: { schema: GarmentMedia, io: 'output' },
  PhotosNeeded: { schema: PhotosNeeded, io: 'output' },
  UploadRequest: { schema: UploadRequest, io: 'input' },
  UploadAuthorization: { schema: UploadAuthorization, io: 'output' },
  UploadCompleteResponse: { schema: UploadCompleteResponse, io: 'output' },
  CompositionManifest: { schema: CompositionManifest, io: 'output' },
  OutfitComposite: { schema: OutfitComposite, io: 'output' },
  StudioChoicesRequest: { schema: StudioChoicesRequest, io: 'input' },
  StudioChoices: { schema: StudioChoices, io: 'output' },
  StudioValidateRequest: { schema: StudioValidateRequest, io: 'input' },
  StudioValidation: { schema: StudioValidation, io: 'output' },
  StudioSuggestRequest: { schema: StudioSuggestRequest, io: 'input' },
  StudioSuggestion: { schema: StudioSuggestion, io: 'output' },
  SavedCombination: { schema: SavedCombination, io: 'output' },
  // API surface additions (surface.ts)
  SwapCandidates: { schema: S.SwapCandidates, io: 'output' },
  RunInputRequest: { schema: S.RunInputRequest, io: 'input' },
  RunInputResponse: { schema: S.RunInputResponse, io: 'output' },
  UploadReceiveResponse: { schema: S.UploadReceiveResponse, io: 'output' },
  PrepareBoardRequest: { schema: S.PrepareBoardRequest, io: 'input' },
  PrepareBoardResponse: { schema: S.PrepareBoardResponse, io: 'output' },
  CreateTripRequest: { schema: S.CreateTripRequest, io: 'input' },
  PackingRequest: { schema: S.PackingRequest, io: 'input' },
  Trip: { schema: S.Trip, io: 'output' },
  TripDetail: { schema: S.TripDetail, io: 'output' },
  TripsResponse: { schema: S.TripsResponse, io: 'output' },
  PackingProposalResponse: { schema: S.PackingProposalResponse, io: 'output' },
  ServicePauseState: { schema: S.ServicePauseState, io: 'output' },
  OrdersResponse: { schema: S.OrdersResponse, io: 'output' },
  ReturnDeadlinesResponse: { schema: S.ReturnDeadlinesResponse, io: 'output' },
  EmailSyncRequest: { schema: S.EmailSyncRequest, io: 'input' },
  EmailSyncResponse: { schema: S.EmailSyncResponse, io: 'output' },
  ComfortFeedbackResponse: { schema: S.ComfortFeedbackResponse, io: 'output' },
  LifecycleProject: { schema: S.LifecycleProject, io: 'output' },
  LifecycleProjectsResponse: { schema: S.LifecycleProjectsResponse, io: 'output' },
  SavedCombinationsResponse: { schema: S.SavedCombinationsResponse, io: 'output' },
  RecoveryKitResponse: { schema: S.RecoveryKitResponse, io: 'output' },
  RecoverRequest: { schema: S.RecoverRequest, io: 'input' },
  RecoverResponse: { schema: S.RecoverResponse, io: 'output' },
  ImportResponse: { schema: S.ImportResponse, io: 'output' },
  OperationReceipt: { schema: S.OperationReceipt, io: 'output' },
  ExportDownloadResult: { schema: S.ExportDownloadResult, io: 'output' },
  StagedImportPackage: { schema: S.StagedImportPackage, io: 'output' },
  McpImportResult: { schema: S.McpImportResult, io: 'output' },
  RecoveryKitLink: { schema: S.RecoveryKitLink, io: 'output' },
  RecoveryStatus: { schema: S.RecoveryStatus, io: 'output' },
  AccountTransfers: { schema: S.AccountTransfers, io: 'output' },
};

export function toJsonSchema(name: string): Record<string, unknown> {
  const entry = JSON_SCHEMA_EXPORTS[name];
  if (!entry) throw new Error(`Unknown schema ${name}`);
  return z.toJSONSchema(entry.schema, { target: 'draft-2020-12', io: entry.io, unrepresentable: 'any' }) as Record<string, unknown>;
}

/** Exact file content written to json-schema/<name>.json. */
export function renderJsonSchemaFile(name: string, contractsVersion: string): string {
  const schema = { $id: `https://garderobe.invalid/contracts/${contractsVersion}/${name}.json`, title: name, ...toJsonSchema(name) };
  return JSON.stringify(schema, null, 2) + '\n';
}
