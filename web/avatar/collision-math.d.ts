import type { Triangle, Vector3 } from 'three';
export interface Capsule { a: Vector3; b: Vector3; radius: number }
export function closestSegments(a0: Vector3, a1: Vector3, b0: Vector3, b1: Vector3): { a: Vector3; b: Vector3; s: number; t: number };
export function capsuleContact(a: Capsule, b: Capsule, margin?: number): null | { normal: Vector3; depth: number; point: Vector3; otherPoint: Vector3; s: number; t: number };
export function projectOutsideCapsule(point: Vector3, capsule: Capsule, thickness?: number, fallback?: Vector3): number;
export function segmentTriangleContact(capsule: Capsule, triangle: Triangle, thickness?: number): null | { normal: Vector3; depth: number; barycentric: Vector3 };
