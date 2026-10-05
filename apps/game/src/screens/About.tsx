/**
 * How it works and how accurate it is: the page to show a hospital before they trust a number.
 * Plain language; figures come from the national fit and the CMS extract, so they stay current.
 */
import { NATIONAL, NATIONAL_ROWS } from '../data/national';

const fmt: Record<'perDay' | 'min' | 'share' | 'hours', (v: number) => string> = {
  perDay: (v) => v.toFixed(0),
  min: (v) => `${Math.round(v)} min`,
  share: (v) => `${(v * 100).toFixed(1)}%`,
  hours: (v) => `${v.toFixed(1)} h`,
};

export function About(props: { onBack: () => void; onDemo: () => void; onPlanner: () => void }) {
  const close = NATIONAL_ROWS.filter((r) => r.close === true).length;
  const judged = NATIONAL_ROWS.filter((r) => r.close !== null).length;
  return (
    <main className="screen about" data-testid="about">
      <p className="eyebrow">ER Planner · how it works</p>
      <h1>How it works, and how far to trust it</h1>
      <p className="lede">
        ER Planner simulates an emergency department patient by patient, week after week, so you can test a change (a shift, more beds, a fast track, more ICU
        beds, a second CT scanner) before you make it, and see where the waiting really comes from.
      </p>

      <section className="card">
        <h2>What happens in a simulated week</h2>
        <ol className="about-steps">
          <li>
            <strong>Patients arrive</strong> by hour and weekday, as they do across US emergency departments, at the volume you set. Each has a hidden condition and
            a triage level (ESI 1–5); some come by ambulance; about 1 in 5 are children.
          </li>
          <li>
            <strong>Registration and triage.</strong> A triage nurse assigns a level, sometimes one off, as in real triage.
          </li>
          <li>
            <strong>A bed and a provider.</strong> Patients wait for a free bed (and, if you model it, a bedside nurse with room at legal ratios), then for a
            doctor or advanced practitioner. Sicker patients go first; minor cases can use a fast track.
          </li>
          <li>
            <strong>Tests.</strong> Lab, X-ray, CT and ultrasound are ordered by condition and can queue for real machines and opening hours.
          </li>
          <li>
            <strong>Decision.</strong> Patients go home or are admitted. Admitted patients wait in their ED bed until an ICU, step-down or ward bed frees up
            (boarding), which blocks the bed for the next patient.
          </li>
          <li>
            <strong>What can go wrong:</strong> patients worsen while waiting, leave without being seen, have something missed and come back within 72 hours, or
            become agitated when waits run long.
          </li>
        </ol>
        <p className="muted small">
          Every run uses a fixed random seed, so the same setup gives the same result. Comparisons run each option on the same simulated weeks (the same patients
          arriving at the same times), so differences come from the change, not from luck. Results are shown as ranges across weeks, and changes with 95% confidence
          intervals.
        </p>
      </section>

      <section className="card" data-testid="about-accuracy">
        <h2>How close it is to real departments</h2>
        <p>
          The starting department is a typical US emergency department (about 98 visits a day, 32 beds, a fast track) fitted to the national survey of US
          emergency visits, {NATIONAL.name}. It matches {close} of {judged} national checks within 10% or a small margin:
        </p>
        <table className="metrics">
          <thead>
            <tr>
              <th>Measure</th>
              <th>US national</th>
              <th>Model</th>
            </tr>
          </thead>
          <tbody>
            {NATIONAL_ROWS.map((r) => (
              <tr key={r.label}>
                <th scope="row">
                  {r.label}
                  {r.close === false && <span className="chip warn"> off</span>}
                </th>
                <td>{r.data === null ? '—' : fmt[r.unit](r.data)}</td>
                <td>{r.model === null ? '—' : fmt[r.unit](r.model)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          For a specific US hospital, the planner can start from its published figures (CMS Care Compare: visits a year, median time in the ED, share leaving before
          being seen) and fit to them. With the hospital’s own visit records it fits to those instead and shows the model beside the data.
        </p>
      </section>

      <section className="card">
        <h2>What it cannot tell you (yet)</h2>
        <ul>
          <li>
            <strong>Your department’s own detail</strong> until you load its data: staffing by hour, real bed counts, test turnaround and inpatient capacity are
            estimates until entered.
          </li>
          <li>
            <strong>Costs</strong> use placeholder rates, not wages or prices; compare options by their direction, not their dollar value.
          </li>
          <li>
            <strong>ICU and step-down stays</strong>, missed-diagnosis rates and violence rates are plausible guesses, labelled as such in the model.
          </li>
          <li>
            <strong>Boarding near full wards</strong> swings a lot with one inpatient bed more or less, in the model as in real hospitals; treat single-number
            boarding results with care.
          </li>
          <li>
            <strong>People, not just numbers:</strong> the model has no teamwork, morale or local workarounds. It shows what the constraints imply, not what will
            happen on a particular day.
          </li>
        </ul>
        <p className="muted small">Results describe the model, not guarantees. Wording is always “best found”, never “optimal”.</p>
      </section>

      <section className="card">
        <h2>How we check the model itself</h2>
        <ul>
          <li>The same seed and setup always give identical results (tested).</li>
          <li>With everything switched off, waits match queueing theory (the Erlang C formula) and Little’s law.</li>
          <li>More doctors never make waits longer when boarding is off.</li>
          <li>Every national figure is read from the official CDC files and checked against the CDC’s own published totals.</li>
        </ul>
      </section>

      <section className="card">
        <h2>To use it for your department</h2>
        <ol>
          <li>Start from your hospital’s published figures, or describe your department (shifts, beds, ICU and ward beds, labs and imaging).</li>
          <li>Optionally load a de-identified visit export (arrival, triage, provider and departure times, acuity, disposition): it stays in your browser.</li>
          <li>Pick the changes to test, run them, and print the report.</li>
        </ol>
      </section>

      <div className="actions">
        <button onClick={props.onBack}>Back</button>
        <button onClick={props.onDemo} data-testid="about-demo">
          Watch the demo
        </button>
        <button className="primary push" onClick={props.onPlanner}>
          Open the planner
        </button>
      </div>
    </main>
  );
}
