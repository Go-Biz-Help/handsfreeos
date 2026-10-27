/**
 * The call's room, loaded the first time someone joins (./phone-call.tsx): LiveKit and its native parts start then,
 * not with the app. Its own file so the screen's tests stand a room in for it.
 */
export const loadRoom = () => import('./room');
