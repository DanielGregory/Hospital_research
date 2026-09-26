/** Whether the browser can draw the 3D view. Kept apart from scene3d so checking it does not load three.js. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}
