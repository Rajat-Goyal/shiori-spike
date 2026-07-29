/**
 * Node and PostgreSQL read independent wall clocks. Keep lifecycle assertions
 * exact while allowing only this small skew at the cross-process boundary.
 */
export const DB_WALL_CLOCK_TOLERANCE_MS = 100;
