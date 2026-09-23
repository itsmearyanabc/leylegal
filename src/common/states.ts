/**
 * Where an advocate practises: every State and Union Territory, as they are
 * written.
 *
 * One list, because three places need the same answer. Signup and the profile
 * screen offer it, the server refuses anything not on it, and precedent search
 * turns it into the High Court whose judgments come first. A free-text field
 * would store "Karnatka" and "KA" and "Bangalore", and none of those names a
 * court.
 */
export const PRACTICE_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

/**
 * The listed spelling of a state, or null when it is not one.
 *
 * Case and spacing are forgiven; anything else is not. "Orissa" is accepted
 * because it is what older enrolment certificates say.
 */
export function canonicalState(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!wanted) return null;
  if (wanted === 'orissa') return 'Odisha';
  return PRACTICE_STATES.find((state) => state.toLowerCase() === wanted) ?? null;
}
