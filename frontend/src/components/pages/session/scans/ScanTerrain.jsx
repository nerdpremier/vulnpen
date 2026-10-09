"use client";

import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import styles from "@/styles/pages/Scans.module.scss";

/**
 * The scan history as a radar scope.
 *
 * The centre is now; every run is a blip placed by how long ago it happened —
 * old runs far out on the rim, recent ones close in — and by the angle its id
 * hashes to, so each run keeps its own bearing. A blip's size is how many cases
 * its run covered, and its colour is how the run ended: green finished, red
 * failed, grey cancelled, the accent live. A sweep line turns the scope once
 * every few seconds, so a live run's blip keeps re-lighting as it passes.
 *
 * Deliberately unlike the other session surfaces: the Overview places findings
 * on a sphere, the plan raises chapters into a skyline, this plots a history on
 * a radar. Drag to orbit, scroll to zoom, hover a blip to name the run, click
 * one to open it.
 */

const TONE = {
  running: "#4aa8e8",
  queued: "#8a8f96",
  completed: "#4ccf92",
  failed: "#e8465a",
  cancelled: "#6a6a6a",
};

const RINGS = [1, 2, 3, 4];
const MAX_R = 4;
const SWEEP_PERIOD = 4.5;

/** One run: a blip on the scope, placed by age (radius) and id (bearing). */
function RunBlip({ scan, age, bearing, cases, busiest, tone, active, dimmed, onHover, onSelect }) {
  /* Older runs sit further out: the rim is the far past, the centre is now. */
  const radius = 0.5 + age * (MAX_R - 0.5);
  const x = Math.cos(bearing) * radius;
  const z = Math.sin(bearing) * radius;
  const size = 0.09 + Math.min(0.15, (cases / busiest) * 0.15);

  const group = useRef();
  const halo = useRef();

  useFrame(({ clock }) => {
    if (group.current) {
      const target = active ? 2.1 : 1;
      const s = group.current.scale.x + (target - group.current.scale.x) * 0.16;
      group.current.scale.set(s, s, s);
    }
    if (halo.current && (scan.status === "running" || active)) {
      halo.current.material.opacity =
        (active ? 0.4 : 0.22) + Math.sin(clock.elapsedTime * 3) * 0.12;
    }
  });

  const opacity = dimmed ? 0.25 : 1;

  return (
    <group position={[x, 0, z]}>
      <group
        ref={group}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(scan);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "auto";
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(scan);
        }}
      >
        {/* The blip. */}
        <mesh position={[0, 0.02, 0]}>
          <sphereGeometry args={[size, 16, 16]} />
          <meshBasicMaterial color={tone} transparent opacity={opacity} />
        </mesh>
        {/* Its halo: a faint disc that a live or hovered run keeps lit. */}
        <mesh ref={halo} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <circleGeometry args={[size * 2.6, 20]} />
          <meshBasicMaterial
            color={tone}
            transparent
            opacity={(active ? 0.4 : 0.16) * opacity}
            depthWrite={false}
          />
        </mesh>
        {/* A pin to the floor, so a blip reads as standing on the scope. */}
        <mesh position={[0, -0.05, 0]} raycast={() => null}>
          <cylinderGeometry args={[0.006, 0.006, 0.1, 6]} />
          <meshBasicMaterial color={tone} transparent opacity={opacity * 0.5} />
        </mesh>
      </group>
    </group>
  );
}

/** The scope itself: range rings, cross hairs, and the turning sweep. */
function Scope() {
  const ringGeometries = useMemo(
    () =>
      RINGS.map((r) => {
        const points = [];
        for (let i = 0; i <= 128; i += 1) {
          const a = (i / 128) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
        }
        return new THREE.BufferGeometry().setFromPoints(points);
      }),
    [],
  );

  const spokes = useMemo(() => {
    const out = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      out.push(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(Math.cos(a) * MAX_R, 0, Math.sin(a) * MAX_R),
        ]),
      );
    }
    return out;
  }, []);

  return (
    <group>
      {ringGeometries.map((geometry, i) => (
        <line key={`ring-${i}`} raycast={() => null}>
          <primitive object={geometry} attach="geometry" />
          <lineBasicMaterial color="#333333" transparent opacity={0.85} />
        </line>
      ))}
      {spokes.map((geometry, i) => (
        <line key={`spoke-${i}`} raycast={() => null}>
          <primitive object={geometry} attach="geometry" />
          <lineBasicMaterial color="#242424" transparent opacity={0.7} />
        </line>
      ))}
      <TheSweep />
    </group>
  );
}

/** The sweep: a bright line that turns the scope, with a soft trailing wedge. */
function TheSweep() {
  const wedgeGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    const span = Math.PI / 4;
    for (let i = 0; i <= 24; i += 1) {
      const a = (i / 24) * span;
      shape.lineTo(Math.cos(a) * MAX_R, Math.sin(a) * MAX_R);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, []);

  const lineGeometry = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(MAX_R, 0, 0),
      ]),
    [],
  );

  const group = useRef();
  useFrame(({ clock }) => {
    if (group.current) {
      group.current.rotation.z = -(clock.elapsedTime / SWEEP_PERIOD) * Math.PI * 2;
    }
  });

  return (
    <group ref={group} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <mesh geometry={wedgeGeometry} raycast={() => null}>
        <meshBasicMaterial
          color="#4ccf92"
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <line raycast={() => null}>
        <primitive object={lineGeometry} attach="geometry" />
        <lineBasicMaterial color="#8effc4" transparent opacity={0.9} />
      </line>
    </group>
  );
}

const ScanTerrain = ({ scans = [], planCases = [], className = "", onPick }) => {
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(null);
  const controls = useRef();

  /* The age of each run, spread across the scope's full radius: the newest run
     sits nearest the centre and the oldest at the rim. Ranked rather than
     scaled by raw elapsed time, because a history can span hours or weeks and
     the scope should use its whole face either way. */
  const runs = useMemo(() => {
    const ordered = [...scans].slice(0, 60);
    const n = Math.max(1, ordered.length - 1);
    /* The golden angle spreads successive bearings without ever repeating, so
       no two runs of the same age land on top of one another. */
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    return ordered.map((scan, index) => ({
      scan,
      /* `scans` arrives newest-first, so index 0 is the newest. */
      age: index / n,
      bearing: index * GOLDEN,
      cases: (scan.testIds ?? []).length || 1,
      tone: TONE[scan.status] ?? TONE.cancelled,
    }));
  }, [scans]);

  const busiest = runs.reduce((most, run) => Math.max(most, run.cases), 1);

  const fov = 42;
  const camDist = (MAX_R + 1.1) / Math.tan((fov * Math.PI) / 360);

  if (failed || !runs.length) {
    return <div className={className} aria-hidden="true" />;
  }

  return (
    <div className={className}>
      <Canvas
        camera={{ position: [0, camDist * 0.72, camDist * 0.72], fov }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onError={() => setFailed(true)}
        onPointerMissed={() => setHovered(null)}
      >
        <OrbitControls
          ref={controls}
          makeDefault
          target={[0, 0, 0]}
          enablePan={false}
          enableZoom
          zoomSpeed={0.7}
          minDistance={3}
          maxDistance={40}
          maxPolarAngle={Math.PI / 2.02}
          rotateSpeed={0.5}
          dampingFactor={0.09}
        />
        <Scope />
        {runs.map((run) => (
          <RunBlip
            key={run.scan.runId}
            scan={run.scan}
            age={run.age}
            bearing={run.bearing}
            cases={run.cases}
            busiest={busiest}
            tone={run.tone}
            active={hovered?.runId === run.scan.runId}
            dimmed={Boolean(hovered) && hovered?.runId !== run.scan.runId}
            onHover={setHovered}
            onSelect={(picked) => onPick?.(picked)}
          />
        ))}
      </Canvas>

      {hovered && (
        <div className={styles.runCaption}>
          <span
            className={styles.runCaptionState}
            style={{ color: TONE[hovered.status] ?? TONE.cancelled }}
          >
            {hovered.status}
          </span>
          <span className={styles.runCaptionName}>
            {(() => {
              const n = (hovered.testIds ?? []).length || 1;
              return `${n} case${n === 1 ? "" : "s"}`;
            })()}
          </span>
          <span className={styles.runCaptionFoot}>click to open the run</span>
        </div>
      )}
    </div>
  );
};

export default ScanTerrain;
