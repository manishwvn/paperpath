export const fields = ['name', 'email', 'availability', 'equipment', 'motivation'] as const;
export type Field = typeof fields[number];
export const requiredFields = ['name', 'email', 'availability', 'equipment'] as const satisfies readonly Field[];
