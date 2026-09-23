/** Fictional names for patients and staff, fixed per run so the same person keeps their name. */
const FIRST = [
  'Ava', 'Noah', 'Maya', 'Leo', 'Zara', 'Omar', 'Lucia', 'Kai', 'Priya', 'Mateo', 'Hana', 'Elijah', 'Amara', 'Luca', 'Nia', 'Felix', 'Sofia', 'Ravi', 'Ingrid',
  'Tomás', 'Aisha', 'Jonah', 'Mei', 'Samuel', 'Yara', 'Diego', 'Freya', 'Kofi', 'Lena', 'Arjun', 'Chloe', 'Ibrahim', 'Rosa', 'Theo', 'Imani', 'Ezra', 'Keiko',
  'Marcus', 'Leila', 'Owen', 'Ana', 'Hugo', 'Fatima', 'Isaac', 'Grace', 'Emeka', 'Julia', 'Tariq', 'Nora', 'Vikram', 'Sade', 'Oscar', 'Ruth', 'Daniel',
];
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

export function personName(kind: 'patient' | 'staff', id: number, seed: number): { first: string; last: string } {
  const h = mix(id + (kind === 'staff' ? 100003 : 0), seed);
  return { first: FIRST[h % FIRST.length]!, last: LAST[Math.floor(h / FIRST.length) % LAST.length]! };
}
