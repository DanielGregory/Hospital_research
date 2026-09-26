/** Fictional names for patients and staff, fixed per run so the same person keeps their name. */
const FIRST_F = [
  'Ava', 'Maya', 'Zara', 'Lucia', 'Priya', 'Hana', 'Amara', 'Nia', 'Sofia', 'Ingrid', 'Aisha', 'Mei', 'Yara', 'Freya', 'Lena', 'Chloe', 'Rosa', 'Imani',
  'Keiko', 'Leila', 'Ana', 'Fatima', 'Grace', 'Julia', 'Nora', 'Sade', 'Ruth', 'Esther', 'Olga', 'Beatriz',
];
const FIRST_M = [
  'Noah', 'Leo', 'Omar', 'Kai', 'Mateo', 'Elijah', 'Luca', 'Felix', 'Ravi', 'Tomás', 'Jonah', 'Samuel', 'Diego', 'Kofi', 'Arjun', 'Ibrahim', 'Theo', 'Ezra',
  'Marcus', 'Owen', 'Hugo', 'Isaac', 'Emeka', 'Tariq', 'Vikram', 'Oscar', 'Daniel', 'Walter', 'Hiroshi', 'Bogdan',
];
const FIRST = [...FIRST_F, ...FIRST_M];
const LAST = [
  'Okafor', 'Lindqvist', 'Haddad', 'Nguyen', 'Moreno', 'Kowalski', 'Achebe', 'Sato', 'Rahman', 'Silva', 'Fischer', 'Mensah', 'Reyes', 'Novak', 'Ibrahim',
  'Park', 'Costa', 'Walsh', 'Abebe', 'Rossi', 'Kaur', 'Dubois', 'Tanaka', 'Hughes', 'Oyelaran', 'Petrov', 'Castillo', 'Byrne', 'Mwangi', 'Larsen', 'Chen',
  'Farah', 'Morgan', 'Patel', 'Alvarez', 'Nakamura', 'Owusu', 'Schmidt', 'Hassan', 'Kim', 'Bianchi', 'Adeyemi', 'Murphy', 'Singh', 'Torres', 'Lund',
];

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 13)) >>> 0;
}

/** A made-up name; pass the patient's sex so the first name fits. */
export function personName(kind: 'patient' | 'staff', id: number, seed: number, sex?: 'F' | 'M'): { first: string; last: string } {
  const h = mix(id + (kind === 'staff' ? 100003 : 0), seed);
  const firsts = sex === 'F' ? FIRST_F : sex === 'M' ? FIRST_M : FIRST;
  return { first: firsts[h % firsts.length]!, last: LAST[Math.floor(h / FIRST.length) % LAST.length]! };
}

/** Display name for a patient. */
export function patientName(id: number, seed: number, sex?: 'F' | 'M'): string {
  const n = personName('patient', id, seed, sex);
  return `${n.first} ${n.last}`;
}
