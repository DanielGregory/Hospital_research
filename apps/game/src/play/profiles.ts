/**
 * Words for patient profiles: what people say brings them in, and short case summaries for the
 * debrief. Presentation only; the sim decides age, sex and complaint. All people are made up.
 */
import type { PatientProfile, PatientStory } from '@er/sim';
import { minutes } from '../format';
import { patientName } from './names';

/** Complaint keys (PARAMS.conditions[].complaints) in patients' own words. */
export const COMPLAINTS: Record<string, readonly string[]> = {
  collapsed: ['collapsed at home', 'found unresponsive', 'collapsed in the street'],
  roadCollision: ['hit by a car', 'motorbike crash', 'car crash on the ring road'],
  fallFromHeight: ['fell off a ladder', 'fell from scaffolding', 'fell down a flight of stairs'],
  assault: ['stab wound', 'assaulted, head injury'],
  confusedFever: ['confused and burning up', 'not making sense, very hot'],
  chestPain: ['pain in my chest', 'tight chest since this morning', 'chest pain going down my arm', 'sharp pain when I breathe in'],
  breathless: ["can't catch my breath", 'short of breath walking', 'breathless since last night'],
  unwell: ['feels awful', 'just not right, very tired', 'dizzy and weak'],
  faceDroop: ['face dropped on one side', 'arm went weak suddenly'],
  slurredSpeech: ['speech is slurred', "words won't come out right"],
  confused: ['suddenly confused', 'not themselves today'],
  fever: ['high temperature for two days', 'fever and shivering'],
  overdose: ['took too many tablets', 'drank and took pills'],
  drowsy: ["very drowsy, hard to wake", "friends can't keep them awake"],
  palpitations: ['heart racing', 'fluttering in my chest'],
  abdominalPain: ['stomach pain', 'pain low on the right', 'belly pain getting worse'],
  vomiting: ["can't stop being sick", 'vomiting since yesterday'],
  cough: ['bad cough', 'coughing up green stuff'],
  flankPain: ['terrible pain in my side', "back pain, can't sit still"],
  wheeze: ['wheezy, inhaler not working', 'chest whistling'],
  ankleInjury: ['twisted my ankle', 'ankle swollen after football'],
  wristInjury: ['fell on my wrist', 'wrist hurts, might be broken'],
  cut: ['cut my hand cooking', 'deep cut on my leg', 'gash on the forehead'],
  urinaryPain: ['burning when I pee', 'pain passing water'],
  fall: ['had a fall', 'tripped on the pavement'],
  rash: ['itchy rash', 'rash all over'],
  soreThroat: ['sore throat', "throat's killing me"],
  prescription: ['ran out of my tablets', 'need a repeat prescription'],
};

/** Stable pick: the same patient always says the same thing. */
export function complaintText(key: string, id: number, seed = 1): string {
  const list = COMPLAINTS[key] ?? ['feels unwell'];
  return list[Math.abs(Math.imul(id + 1, 2654435761) ^ seed) % list.length]!;
}

/** "72-year-old man", "6-year-old girl", "baby boy" */
export function ageSex(p: PatientProfile): string {
  const f = p.sex === 'F';
  if (p.age < 1) return f ? 'baby girl' : 'baby boy';
  if (p.age < 13) return `${p.age}-year-old ${f ? 'girl' : 'boy'}`;
  if (p.age < 18) return `${p.age}-year-old teenage ${f ? 'girl' : 'boy'}`;
  return `${p.age}-year-old ${f ? 'woman' : 'man'}`;
}

/** "Ava Okafor, 72: “pain in my chest”" */
export function profileLine(id: number, p: PatientProfile, seed = 1): string {
  return `${patientName(id, seed, p.sex)}, ${p.age}: “${complaintText(p.complaint, id, seed)}”`;
}

const esi = (a: number | undefined) => (a === undefined ? 'never triaged' : `ESI ${a}`);

/** A two-sentence case summary for the debrief. Reveals the hidden condition: only after the run. */
export function storyText(s: PatientStory, seed = 1): { title: string; body: string } {
  const who = `${patientName(s.patientId, seed, s.profile.sex)}, ${ageSex(s.profile)}`;
  const said = `“${complaintText(s.profile.complaint, s.patientId, seed)}”`;
  const came = s.byAmbulance ? 'Came by ambulance' : 'Walked in';
  const triage = s.triagedAs === undefined ? '' : s.triagedAs === s.arrivalAcuity ? `, triaged ${esi(s.triagedAs)}` : `, triaged ${esi(s.triagedAs)} (really ${esi(s.arrivalAcuity)})`;
  const wait = s.stillWaiting ? ` Still waiting for a doctor after ${minutes(s.waitMinutes)} when the shift ended.` : ` Waited ${minutes(s.waitMinutes)} for a doctor.`;
  const it = `It was ${s.condition.toLowerCase()}.`;
  switch (s.kind) {
    case 'missed':
      return { title: 'Sent home, but something was missed', body: `${who}: ${said}. ${came}${triage}. Sent home; it was ${s.condition.toLowerCase()}. Will be back within 72 hours, sicker.` };
    case 'becameCritical':
      return { title: 'Got much worse while waiting', body: `${who}: ${said}. ${came}${triage}.${wait} Became critical before a doctor saw them. ${it}` };
    case 'leftUnseen':
      return { title: 'Gave up and left', body: `${who}: ${said}. ${came}${triage}. Left after ${minutes(s.waitMinutes)} without seeing anyone. ${it}` };
    case 'longestWait':
      return { title: 'The longest wait', body: `${who}: ${said}. ${came}${triage}.${wait} ${it}` };
    case 'boardedLongest':
      return { title: 'Admitted, but no ward bed', body: `${who}: ${said}. Admitted, then spent ${minutes(s.boardingMinutes)} in an ED bed waiting for a ward. ${it}` };
    case 'quickResponse':
      return { title: 'Seen fast', body: `${who}: ${said}. ${came}${triage}. A doctor was there in ${minutes(s.waitMinutes)}. ${it}` };
  }
}
