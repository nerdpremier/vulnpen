"use client";

import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import styles from "@/styles/pages/TestPlan.module.scss";

/**
 * The plan as a skyline — one tower per WSTG chapter, in the order the plan
 * lists them.
 *
 * A tower is solid, and its height is how many cases the chapter holds. Its
 * colour is read bottom-up as one continuous band per outcome: what the chapter
 * failed sits at the base, what it passed rises above, and the work nobody
 * reached caps the stack in the dim tone. So a chapter that ran everything and
 * failed everything is a short, all-red tower, and a well-covered chapter is a
 * tall one that is mostly green.
 *
 * Deliberately a different construction from the Overview's sphere: the sphere
 * places findings on a shell by severity; this raises chapters off the ground by
 * size. Drag to orbit, scroll to zoom, hover a tower to name it, click one to
 * open its chapter in the table below.
 */

const RESULT_TONE = {
  passed: "#4ccf92",
  failed: "#e8465a",
  blocked: "#e0872f",
  in_progress: "#4aa8e8",
  skipped: "#5b5b5b",
  not_started: "#3a3a3a",
};

/* A fixed band height per case, so two chapters of 4 and 10 cases differ by the
   ratio of their heights and nothing else. */
const UNIT = 0.26;
const MAX_UNITS = 16;
const COLUMN_GAP = 0.98;
const WIDTH = 0.62;

/** One outcome's share of a chapter, as a solid band in the tower. */
function Band({ y, height, tone, active, dimmed }) {
  return (
    <mesh position={[0, y + height / 2, 0]}>
      <boxGeometry args={[WIDTH, height, WIDTH]} />
      <meshBasicMaterial
        color={tone}
        transparent
        opacity={dimmed ? 0.28 : 1}
      />
      {/* A hairline cap on the top band so a tower reads against the dark. */}
      {active && (
        <lineSegments raycast={() => null}>
          <edgesGeometry args={[new THREE.BoxGeometry(WIDTH, height, WIDTH)]} />
          <lineBasicMaterial color="#ffffff" transparent opacity={0.5} />
        </lineSegments>
      )}
    </mesh>
  );
}

/** One chapter: a solid tower of its cases, standing on the ground plane. */
function ChapterTower({ group, x, active, dimmed, onHover, onSelect }) {
  /* The bands, bottom-up: failed, blocked, in progress, passed, then the work
     nobody reached. Each is one count of cases tall, so the tower's total height
     is its case count. */
  const bands = useMemo(() => {
    const counts = { failed: 0, blocked: 0, in_progress: 0, passed: 0, skipped: 0, not_started: 0 };
    for (const testCase of group.cases) {
      counts[testCase.status] = (counts[testCase.status] ?? 0) + 1;
    }
    const order = ["failed", "blocked", "in_progress", "passed", "skipped", "not_started"];
    const out = [];
    let y = 0;
    for (const status of order) {
      const count = counts[status] ?? 0;
      if (!count) continue;
      const height = count * UNIT;
      out.push({ status, y, height, tone: RESULT_TONE[status] });
      y += height;
    }
    return out;
  }, [group]);

  const total = Math.max(1, group.cases.length);
  const scale = Math.min(1, MAX_UNITS / total);

  const lift = useRef();
  const targetLift = active ? 0.3 : 0;

  useFrame(() => {
    if (lift.current) {
      lift.current.position.y += (targetLift - lift.current.position.y) * 0.14;
    }
  });

  return (
    <group position={[x, 0, 0]}>
      <group
        ref={lift}
        scale={[1, scale, 1]}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(group);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "auto";
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(group);
        }}
      >
        {bands.map((band) => (
          <Band
            key={band.status}
            y={band.y}
            height={band.height}
            tone={band.tone}
            active={active}
            dimmed={dimmed}
          />
        ))}
      </group>

      {/* The chapter's code under the tower: without it the towers are an
          anonymous bar chart. */}
      <Html
        center
        position={[0, -0.35, 0]}
        distanceFactor={13}
        pointerEvents="none"
        zIndexRange={[10, 0]}
      >
        <span className={styles.towerCode} data-active={active ? "yes" : "no"}>
          {group.code || "OTHER"}
        </span>
      </Html>
    </group>
  );
}

/** The ground the towers stand on: a faint grid, so depth is readable. */
function GroundPlane({ width }) {
  const grid = useMemo(() => {
    const helper = new THREE.GridHelper(width, Math.max(6, Math.round(width)), "#2b2b2b", "#1b1b1b");
    helper.material.transparent = true;
    helper.material.opacity = 0.5;
    return helper;
  }, [width]);
  return <primitive object={grid} position={[0, 0, 0]} raycast={() => null} />;
}

/** A slow sway that ends the moment the operator takes the wheel. */
function IdleDrift({ controls }) {
  const idle = useRef(true);
  const base = useRef(null);

  React.useEffect(() => {
    const node = controls.current;
    if (!node) return undefined;
    const stop = () => {
      idle.current = false;
    };
    node.addEventListener("start", stop);
    return () => node.removeEventListener("start", stop);
  }, [controls]);

  useFrame(({ clock }) => {
    const node = controls.current;
    if (!node || !idle.current) return;
    if (base.current === null) base.current = node.getAzimuthalAngle();
    node.setAzimuthalAngle(base.current + Math.sin(clock.elapsedTime * 0.22) * 0.16);
  });

  return null;
}

const PlanTerrain = ({ groups = [], className = "", onPick }) => {
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(null);
  const controls = useRef();

  const towers = useMemo(() => groups.slice(0, 12), [groups]);

  const rowWidth = Math.max(1, towers.length - 1) * COLUMN_GAP + WIDTH;
  const tallest = useMemo(
    () => towers.reduce((most, group) => Math.max(most, group.cases.length), 1),
    [towers],
  );
  const towerTop = Math.min(tallest, MAX_UNITS) * UNIT;

  /* Framing is computed, not eyeballed: the stage is very wide and short, so a
     hand-picked distance always favours one axis. */
  const fov = 40;
  const fitH = towerTop / 2 / Math.tan((fov * Math.PI) / 360) + 0.4;
  const fitW = rowWidth / 2 / Math.tan((fov * Math.PI) / 360) / 2.2;
  const camZ = Math.max(fitH, fitW) * 1.2;
  const targetY = towerTop * 0.46;
  const camY = targetY + camZ * 0.22;

  const active = hovered;

  if (failed || !towers.length) {
    return <div className={className} aria-hidden="true" />;
  }

  return (
    <div className={className}>
      <Canvas
        camera={{ position: [0, camY, camZ], fov }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onError={() => setFailed(true)}
        onPointerMissed={() => setHovered(null)}
      >
        <OrbitControls
          ref={controls}
          makeDefault
          target={[0, targetY, 0]}
          enablePan
          enableZoom
          zoomSpeed={0.7}
          minDistance={4}
          maxDistance={60}
          maxPolarAngle={Math.PI / 2.06}
          rotateSpeed={0.5}
          dampingFactor={0.09}
        />
        <IdleDrift controls={controls} />
        <GroundPlane width={Math.max(8, rowWidth + 2)} />
        {towers.map((group, index) => (
          <ChapterTower
            key={group.key}
            group={group}
            x={(index - (towers.length - 1) / 2) * COLUMN_GAP}
            active={active?.key === group.key}
            dimmed={Boolean(active) && active?.key !== group.key}
            onHover={setHovered}
            onSelect={(picked) => onPick?.(picked)}
          />
        ))}
      </Canvas>

      {active && (
        <div className={styles.towerCaption}>
          <span className={styles.towerCaptionCode}>{active.code || "OTHER"}</span>
          <span className={styles.towerCaptionName}>{active.name}</span>
          <span className={styles.towerCaptionFoot}>
            {active.cases.length} cases · click to open
          </span>
        </div>
      )}
    </div>
  );
};

export default PlanTerrain;
