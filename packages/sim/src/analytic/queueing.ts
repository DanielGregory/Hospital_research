/** Closed-form queueing results used to validate the simulator. */

export interface MMcResult {
  /** Offered load a = λ/μ. */
  offeredLoad: number;
  /** Server utilisation ρ = λ/(cμ). */
  utilization: number;
  /** Erlang C: probability an arrival has to wait. */
  probWait: number;
  /** Mean time in queue. */
  meanWait: number;
  /** Mean time in system. */
  meanTimeInSystem: number;
  /** Mean number waiting (Lq). */
  meanQueueLength: number;
}

/**
 * M/M/c steady state. `lambda` = arrival rate, `meanService` = 1/μ, same time unit.
 * Throws if the queue is unstable (ρ >= 1).
 */
export function mmc(lambda: number, meanService: number, c: number): MMcResult {
  const mu = 1 / meanService;
  const a = lambda / mu;
  const rho = a / c;
  if (!(rho < 1)) throw new Error(`M/M/c unstable: rho = ${rho}`);
  // Erlang B by the stable recursion, then convert to Erlang C.
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const probWait = b / (1 - rho + rho * b);
  const meanWait = probWait / (c * mu - lambda);
  return {
    offeredLoad: a,
    utilization: rho,
    probWait,
    meanWait,
    meanTimeInSystem: meanWait + meanService,
    meanQueueLength: lambda * meanWait,
  };
}
