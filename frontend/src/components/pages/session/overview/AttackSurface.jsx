"use client";

import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import styles from "@/styles/pages/Overview.module.scss";

/**
 * The engagement's attack surface, in three dimensions — and in the operator's
 * hands.
 *
 * The target sits at the core as one bright node; every recorded finding is a
 * node on the surface, placed on the bearing its own id hashes to and pushed
 * out by severity, so the worst findings stand furthest and glow hottest. Drag
 * to orbit, scroll to zoom, hover a node to name it, click one to pin it and
 * read what it is — and follow it through to the full record.
 *
 * Primitives only: no models, no textures, no post-processing. It is a shape
 * of the work, and every fact it shows is also on the page as text.
 */

const SEV_TONE = {
  critical: "#ff4d5e",
  high: "#ff8a3d",
  medium: "#ffd166",
  low: "#7fb2ff",
  info: "#79d1ff",
};

const SEV_RADIUS = { critical: 3.2, high: 2.8, medium: 2.4, low: 2.0, info: 1.7 };
const SEV_SIZE = { critical: 0.15, high: 0.125, medium: 0.1, low: 0.08, info: 0.065 };

/** Deterministic hash → [0,1), so a finding keeps its place between renders. */
function hash01(value) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

/** The core: the engagement's target. A bright point with a soft corona. */
function TargetCore() {
  const halo = useRef();
  const halo2 = useRef();

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (halo.current) halo.current.scale.setScalar(1 + Math.sin(t * 1.8) * 0.1);
    if (halo2.current) halo2.current.scale.setScalar(1 + Math.sin(t * 1.3 + 1) * 0.16);
  });

  return (
    <group>
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.16, 24, 24]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <mesh ref={halo} raycast={() => null}>
        <sphereGeometry args={[0.4, 24, 24]} />
        <meshBasicMaterial color="#cfe6ff" transparent opacity={0.22} depthWrite={false} />
      </mesh>
      <mesh ref={halo2} raycast={() => null}>
        <sphereGeometry args={[0.78, 24, 24]} />
        <meshBasicMaterial color="#8fb8ff" transparent opacity={0.08} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** A few concentric rings that suggest depth without a heavy cage. */
function OrbitRings({ radius }) {
  const ref = useRef();
  const rings = [radius * 0.55, radius * 0.8, radius];

  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.y = clock.elapsedTime * 0.04;
  });

  return (
    <group ref={ref}>
      {rings.map((r, index) => (
        <mesh
          key={r}
          rotation={[index * 0.5, 0, index * 0.3]}
          raycast={() => null}
        >
          <ringGeometry args={[r, r + 0.004, 96]} />
          <meshBasicMaterial
            color="#7d8187"
            transparent
            opacity={0.16}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** One finding: a glowing node with a line strung back to the target core. */
function FindingNode({ finding, active, dimmed, onHover, onSelect }) {
  const severity = String(finding.severity ?? "info").toLowerCase();
  const radius = SEV_RADIUS[severity] ?? 2;
  const size = SEV_SIZE[severity] ?? 0.07;
  const tone = SEV_TONE[severity] ?? SEV_TONE.info;

  const position = useMemo(() => {
    const u = hash01(finding.vulnerabilityId);
    const v = hash01(`${finding.vulnerabilityId}:v`);
    const theta = u * Math.PI * 2;
    const phi = Math.acos(1 - 2 * v);
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    ];
  }, [finding.vulnerabilityId, radius]);

  const node = useRef();

  useFrame(({ clock }) => {
    if (node.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 2 + radius * 3) * 0.18;
      node.current.scale.setScalar(pulse);
    }
  });

  const tether = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(...position),
      ]),
    [position],
  );

  const opacity = dimmed ? 0.25 : 1;

  return (
    <group>
      <line>
        <primitive object={tether} attach="geometry" />
        <lineBasicMaterial
          color={tone}
          transparent
          opacity={active ? 0.55 : 0.2 * opacity}
        />
      </line>
      <mesh
        ref={node}
        position={position}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(finding);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "auto";
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(finding);
        }}
      >
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color={tone} transparent opacity={opacity} />
      </mesh>
      <mesh position={position}>
        <sphereGeometry args={[size * 2.2, 16, 16]} />
        <meshBasicMaterial
          color={tone}
          transparent
          opacity={(active ? 0.4 : 0.2) * opacity}
          depthWrite={false}
        />
      </mesh>
      <mesh position={position}>
        <sphereGeometry args={[size * (active ? 5 : 3.6), 16, 16]} />
        <meshBasicMaterial
          color={tone}
          transparent
          opacity={(active ? 0.16 : 0.07) * opacity}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Auto-orbits until the operator takes the wheel. */
function AutoOrbit({ controls }) {
  const idle = useRef(true);

  useFrame((_, delta) => {
    if (controls.current && idle.current) {
      controls.current.setAzimuthalAngle(
        controls.current.getAzimuthalAngle() + delta * 0.06,
      );
    }
  });

  return null;
}

const AttackSurface = ({ findings = [], sessionId, className = "" }) => {
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);
  const controls = useRef();

  /* Cap the node count: the surface is a shape, not a scatter plot. Worst
     findings first, so the ones you can see are the ones that matter. */
  const shown = useMemo(() => findings.slice(0, 40), [findings]);
  const active = hovered ?? selected;

  if (failed || !shown.length) {
    return <div className={className} aria-hidden="true" />;
  }

  return (
    <div className={className}>
      <Canvas
        camera={{ position: [0, 0, 8.4], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onError={() => setFailed(true)}
        onPointerMissed={() => setSelected(null)}
      >
        <OrbitControls
          ref={controls}
          makeDefault
          enablePan={false}
          enableZoom
          zoomSpeed={0.7}
          minDistance={3}
          maxDistance={16}
          rotateSpeed={0.6}
          dampingFactor={0.08}
        />
        <AutoOrbit controls={controls} />
        <OrbitRings radius={3.4} />
        <TargetCore />
        {shown.map((finding) => (
          <FindingNode
            key={finding.vulnerabilityId}
            finding={finding}
            active={active?.vulnerabilityId === finding.vulnerabilityId}
            dimmed={Boolean(active) && active?.vulnerabilityId !== finding.vulnerabilityId}
            onHover={setHovered}
            onSelect={setSelected}
          />
        ))}
      </Canvas>

      {/* The hovered/pinned finding reads as a caption over the canvas, and a
          selected one links through to its full record. */}
      {active && (
        <div className={styles.caption}>
          <span
            className={styles.captionSev}
            style={{ color: SEV_TONE[String(active.severity).toLowerCase()] ?? SEV_TONE.info }}
          >
            {String(active.severity ?? "info").toLowerCase()}
          </span>
          <span className={styles.captionTitle}>
            {active.title || active.vulnerabilityId}
          </span>
          {(active.endpoint || active.service || active.host) && (
            <span className={styles.captionEndpoint}>
              {active.endpoint || active.service || active.host}
            </span>
          )}
          {selected?.vulnerabilityId === active.vulnerabilityId && (
            <a
              className={styles.captionLink}
              href={`/session/${sessionId}/vulnerabilities/${active.vulnerabilityId}`}
            >
              open finding →
            </a>
          )}
        </div>
      )}
    </div>
  );
};

export default AttackSurface;
