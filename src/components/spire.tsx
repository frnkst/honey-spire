"use client";

import { useEffect, useRef } from "react";

const GOLD = "255, 194, 71";
const CYAN = "98, 200, 220";

interface Node {
  x: number;
  y: number;
  z: number;
}

/**
 * A wireframe honey spire rendered on a 2D canvas with hand-rolled 3D
 * projection: hexagonal cells stacked into a tapering tower, a scanning ring
 * sweeping the structure, and a radar pad underneath. Pure canvas — no WebGL.
 */
export function HoneySpire({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;

    const LEVELS = 14;
    const SIDES = 6;
    const PITCH = 0.34;

    // Model space: hexagonal rings tapering toward an open crown, y up.
    const rings: Node[][] = [];
    for (let level = 0; level < LEVELS; level++) {
      const t = (level / (LEVELS - 1)) * 0.88;
      const radius = 0.92 * Math.pow(1 - t, 1.45);
      const ring: Node[] = [];
      for (let side = 0; side < SIDES; side++) {
        const angle = (side / SIDES) * Math.PI * 2;
        ring.push({
          x: Math.cos(angle) * radius,
          y: t * 1.9 - 0.85,
          z: Math.sin(angle) * radius,
        });
      }
      rings.push(ring);
    }
    const crown: Node = { x: 0, y: 1.1, z: 0 };
    const mastTip: Node = { x: 0, y: 1.4, z: 0 };

    let rotation = 0.55;
    let frameHandle = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = element.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      element.width = Math.max(1, Math.round(width * dpr));
      element.height = Math.max(1, Math.round(height * dpr));
    };

    const draw = (time: number) => {
      if (width < 10 || height < 10) return;
      const dpr = element.width / width;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const scale = Math.min(width / 2.9, height / 2.7);
      const cx = width / 2;
      const cy = height * 0.56;
      const cosP = Math.cos(PITCH);
      const sinP = Math.sin(PITCH);

      const projector = (angle: number) => {
        const cosR = Math.cos(angle);
        const sinR = Math.sin(angle);
        return (x: number, y: number, z: number) => {
          const rx = x * cosR - z * sinR;
          const rz = x * sinR + z * cosR;
          const ty = y * cosP - rz * sinP;
          const tz = y * sinP + rz * cosP;
          const perspective = 2.6 / (2.6 + tz);
          return {
            sx: cx + rx * perspective * scale,
            sy: cy - ty * perspective * scale,
            tz,
          };
        };
      };

      const project = projector(rotation);
      const projectPad = projector(-rotation * 0.45);

      // Depth shading: near the camera is brighter.
      const shade = (tz: number) =>
        Math.min(0.85, Math.max(0.08, 0.2 + 0.62 * (1 - (tz + 1.7) / 3.4)));

      const ringPoints = rings.map((ring) =>
        ring.map((node) => project(node.x, node.y, node.z)),
      );
      const crownPoint = project(crown.x, crown.y, crown.z);
      const mastPoint = project(mastTip.x, mastTip.y, mastTip.z);
      const padCenter = project(0, -0.85, 0);

      const line = (
        from: { sx: number; sy: number },
        to: { sx: number; sy: number },
        style: string,
        lineWidth = 1,
      ) => {
        context.strokeStyle = style;
        context.lineWidth = lineWidth;
        context.beginPath();
        context.moveTo(from.sx, from.sy);
        context.lineTo(to.sx, to.sy);
        context.stroke();
      };

      const polygon = (
        points: { sx: number; sy: number }[],
        style: string,
        lineWidth: number,
        glow = 0,
      ) => {
        context.strokeStyle = style;
        context.lineWidth = lineWidth;
        context.shadowColor = `rgba(${CYAN}, .8)`;
        context.shadowBlur = glow;
        context.beginPath();
        points.forEach((point, index) => {
          if (index === 0) context.moveTo(point.sx, point.sy);
          else context.lineTo(point.sx, point.sy);
        });
        context.closePath();
        context.stroke();
        context.shadowBlur = 0;
      };

      // Ground glow.
      const glow = context.createRadialGradient(
        padCenter.sx,
        padCenter.sy,
        0,
        padCenter.sx,
        padCenter.sy,
        scale * 1.35,
      );
      glow.addColorStop(0, `rgba(${GOLD}, .07)`);
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      // Central axis, dashed.
      context.setLineDash([2, 5]);
      line(mastPoint, padCenter, `rgba(${GOLD}, .22)`);
      context.setLineDash([]);

      // Radar pad: two counter-rotating hexagons with spokes.
      const padHex = (radius: number, alpha: number) => {
        const points = [];
        for (let side = 0; side < SIDES; side++) {
          const angle = (side / SIDES) * Math.PI * 2;
          points.push(
            projectPad(
              Math.cos(angle) * radius,
              -0.85,
              Math.sin(angle) * radius,
            ),
          );
        }
        polygon(points, `rgba(${CYAN}, ${alpha})`, 1);
        return points;
      };
      const outerPad = padHex(1.32, 0.24);
      const innerPad = padHex(1.14, 0.16);
      for (let side = 0; side < SIDES; side++) {
        line(outerPad[side], innerPad[side], `rgba(${CYAN}, .1)`);
      }

      // Honeycomb lattice: verticals plus a twist of diagonals per level.
      for (let level = 0; level < LEVELS - 1; level++) {
        for (let side = 0; side < SIDES; side++) {
          const next = (side + 1) % SIDES;
          const here = ringPoints[level][side];
          const above = ringPoints[level + 1][side];
          const across = ringPoints[level + 1][next];
          line(
            here,
            above,
            `rgba(${GOLD}, ${((shade(here.tz) + shade(above.tz)) / 2) * 0.75})`,
          );
          line(
            here,
            across,
            `rgba(${GOLD}, ${((shade(here.tz) + shade(across.tz)) / 2) * 0.38})`,
          );
        }
      }

      // Ring perimeters, foundation slightly heavier.
      for (let level = 0; level < LEVELS; level++) {
        const points = ringPoints[level];
        const depth = points.reduce((sum, point) => sum + point.tz, 0) / SIDES;
        polygon(points, `rgba(${GOLD}, ${shade(depth)})`, level < 2 ? 1.3 : 1);
      }

      // Open crown and mast.
      for (const point of ringPoints[LEVELS - 1]) {
        line(point, crownPoint, `rgba(${GOLD}, ${shade(crownPoint.tz) * 0.8})`);
      }
      line(crownPoint, mastPoint, `rgba(${GOLD}, ${shade(mastPoint.tz)})`, 1.4);

      // Scan ring sweeping the structure.
      const scanLevel =
        ((Math.sin(time * 0.55 - Math.PI / 2) + 1) / 2) * (LEVELS - 1);
      const lower = Math.floor(scanLevel);
      const frac = scanLevel - lower;
      const upper = Math.min(lower + 1, LEVELS - 1);
      const scanPoints = rings[lower].map((node, side) =>
        project(
          node.x + (rings[upper][side].x - node.x) * frac,
          node.y + (rings[upper][side].y - node.y) * frac,
          node.z + (rings[upper][side].z - node.z) * frac,
        ),
      );
      polygon(scanPoints, `rgba(${CYAN}, .9)`, 1.4, 12);

      // Cell nodes as tiny square sensors.
      for (const points of ringPoints) {
        for (const point of points) {
          context.fillStyle = `rgba(${GOLD}, ${shade(point.tz) * 0.7})`;
          context.fillRect(point.sx - 0.8, point.sy - 0.8, 1.6, 1.6);
        }
      }

      // Beacon on the mast.
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.6);
      context.shadowColor = `rgba(${GOLD}, .9)`;
      context.shadowBlur = 6 + 10 * pulse;
      context.fillStyle = `rgba(${GOLD}, ${0.5 + 0.5 * pulse})`;
      context.beginPath();
      context.arc(mastPoint.sx, mastPoint.sy, 1.8 + pulse, 0, Math.PI * 2);
      context.fill();
      context.shadowBlur = 0;
    };

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    if (reducedMotion) {
      draw(1.4);
    } else {
      let last = 0;
      const loop = (now: number) => {
        const time = now / 1000;
        const elapsed = last ? Math.min(time - last, 0.1) : 0.016;
        last = time;
        rotation += elapsed * 0.38;
        draw(time);
        frameHandle = requestAnimationFrame(loop);
      };
      frameHandle = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(frameHandle);
      observer.disconnect();
    };
  }, []);

  return <canvas className={className} ref={canvas} />;
}
