import type { CommandType } from '@garderobe/contracts';
import { amendWear, recordWear } from '../wear.js';
import { laundryCollected, laundryReturned, markInWash, markWashed, socksWashed } from '../laundry.js';
import { addItem, backFromTailor, disposeItem, markArrived, putIntoStorage, reconcileQuantity, sendToTailor, takeOutOfStorage } from '../inventory.js';
import { liftRestriction, setRestriction } from '../restrictions.js';
import { selectOption } from '../boards.js';
import { editStyleProfile, setTemporaryBrief } from '../style.js';
import { planUndo } from './undo.js';
import type { Handler } from './types.js';
// Intake and lifecycle handlers live with their workstream; registered here so every mutation
// shares one command path, receipt store and outbox.
import { importOrder, recordOrderEvent } from '../../intake/handlers.js';
import { advanceLifecycleProject, openLifecycleProject, recordComfortFeedback, recordReturnTerms } from '../../lifecycle/handlers.js';
import { planOutfit, removeCombination, saveCombination } from '../../studio/commands.js';
import { updateDeliverySettings } from '../settings.js';
import { pauseService, resumeService } from '../service-pause.js';

/** Every command type has exactly one handler. */
export const HANDLERS: { [T in CommandType]: Handler<T> } = {
  record_wear: recordWear,
  amend_wear: amendWear,
  mark_in_wash: markInWash,
  mark_washed: markWashed,
  socks_washed: socksWashed,
  laundry_collected: laundryCollected,
  laundry_returned: laundryReturned,
  laundry_partial_return: laundryReturned,
  send_to_tailor: sendToTailor,
  back_from_tailor: backFromTailor,
  mark_arrived: markArrived,
  put_into_storage: putIntoStorage,
  take_out_of_storage: takeOutOfStorage,
  reconcile_quantity: reconcileQuantity,
  add_item: addItem,
  set_restriction: setRestriction,
  lift_restriction: liftRestriction,
  select_option: selectOption,
  undo: planUndo,
  edit_style_profile: editStyleProfile,
  set_temporary_brief: setTemporaryBrief,
  dispose_item: disposeItem,
  import_order: importOrder,
  record_order_event: recordOrderEvent,
  record_return_terms: recordReturnTerms,
  record_comfort_feedback: recordComfortFeedback,
  open_lifecycle_project: openLifecycleProject,
  advance_lifecycle_project: advanceLifecycleProject,
  save_combination: saveCombination,
  plan_outfit: planOutfit,
  remove_combination: removeCombination,
  update_delivery_settings: updateDeliverySettings,
  pause_service: pauseService,
  resume_service: resumeService,
};
