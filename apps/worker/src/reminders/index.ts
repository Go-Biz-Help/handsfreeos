/**
 * What someone asked the Assistant to do on its own (the owner, 25 Nov 2026): a task's ping at its time
 * (task-due.ts), a question asked on a schedule (questions.ts), and alerts when something happens (alerts.ts).
 */
import { handlersFor, type EventHandler, type HandlerMap } from '../handlers/types';
import { onAlertBooking, onAlertPayment, onAlertReply } from './alerts';
import { onRoutineChanged } from './questions';
import { onArmTaskDue } from './task-due';

const REMINDER_HANDLERS: Readonly<Record<string, EventHandler>> = {
  'task.created': onArmTaskDue,
  'task.updated': onArmTaskDue,
  'task.reopened': onArmTaskDue,
  'assistant_routine.changed': onRoutineChanged,
  'message.received': onAlertReply,
  'appointment.booked': onAlertBooking,
  'invoice.paid': onAlertPayment,
};

/** Appends each one after what the event already does (handlers/index.ts). */
export function withReminders(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const [type, handler] of Object.entries(REMINDER_HANDLERS))
    out[type] = [...handlersFor(handlers, type), handler];
  return out;
}

export { ROUTINE_QUESTION_JOB, routineQuestionJob } from './questions';
export { TASK_DUE_JOB, taskDueJob } from './task-due';
export { alertOnReview } from './alerts';
