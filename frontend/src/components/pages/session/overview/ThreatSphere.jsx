"use client";

import React, { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

/**
 * The engagement as a sphere of test chapters.
 *
 * Every WSTG chapter is one node on the shell, sized by how many cases it
 * holds and coloured by its outcome — green when every settled case passed,
 * red the moment one failed, dim when nothing has run yet. A drifting particle
 * field and a bloom pass give the shell depth, so the shape of the work (where
 * it is done, where it hurts, where nothing has happened) reads before a
 * single number does.
 *
 * Dependency-light by design: three primitives plus one post-processing pass,
 * no models, no textures, no external assets.
 */

const TONE = {
  passed: "#5fd39a",
  failed: "#ff6b6b",
  blocked: "#e9c46a",
  idle: "#7d8187",
};

/** The outcome a chapter node should wear, worst news first. */
function toneFor(row) {
  if (row.counts.failed > 0) return "failed";
  if (row.counts.blocked > 0) return "blocked";
  if (row.counts.passed > 0) return "passed";
  return "idle";
}

/**
 * Fibonacci-sphere placement: even spacing around a shell without clustering
 * at the poles, which is what a naive lat/long grid does.
 */
function spherePoint(index, count, radius) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (index / Math.max(1, count - 1)) * 2;
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * index;
  return new THREE.Vector3(
    Math.cos(theta) * ringRadius * radius,
    y * radius,
    Math.sin(theta) * ringRadius * radius,
  );
}

/** One chapter node: a glowing ball sized by the chapter's weight. */
function ChapterNode({ position, size, tone, dimmed, phase }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 1.4 + phase) * 0.07;
    ref.current.scale.setScalar(pulse);
  });

  return (
    <group position={position}>
      {/* The core reads as the node; the halo is what blooms. */}
      <mesh ref={ref}>
        <sphereGeometry args={[size, 20, 20]} />
        <meshBasicMaterial
          color={TONE[tone]}
          transparent
          opacity={dimmed ? 0.4 : 1}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[size * 1.9, 16, 16]} />
        <meshBasicMaterial
          color={TONE[tone]}
          transparent
          opacity={dimmed ? 0.06 : 0.16}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** The wireframe shell the nodes sit on. */
function Shell({ radius }) {
  const ref = useRef();
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.035;
  });
  return (
    <mesh ref={ref}>
      <icosahedronGeometry args={[radius, 3]} />
      <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.05} />
    </mesh>
  );
}

/** A drifting field of points around and inside the shell. */
function ParticleField({ count = 420, radius = 4.4 }) {
  const ref = useRef();

  const positions = useMemo(() => {
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      /* A shell-biased scatter: points spaced out to the outer radius, so they
         read as a volume around the sphere rather than a dense ball inside. */
      const r = radius * (0.55 + Math.pow(Math.random(), 0.5) * 0.45);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      array[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      array[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      array[i * 3 + 2] = r * Math.cos(phi);
    }
    return array;
  }, [count, radius]);

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.02;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.035}
        color="#9fb0c6"
        transparent
        opacity={0.5}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

/** The whole scene, inside one group the pointer tilts. */
function Scene({ rows }) {
  const group = useRef();
  const pointer = useRef({ x: 0, y: 0 });
  const { viewport } = useThree();

  const nodes = useMemo(() => {
    const radius = 2.15;
    const maxTotal = Math.max(1, ...rows.map((row) => row.total));
    return rows.map((row, index) => ({
      key: row.key,
      tone: toneFor(row),
      /* Node size reads the chapter's weight within a tight band, so a
         19-case chapter does not dwarf a 1-case one. */
      size: 0.09 + (row.total / maxTotal) * 0.1,
      position: spherePoint(index, rows.length, radius),
      dimmed: row.counts.not_started === row.total,
      phase: index * 1.7,
    }));
  }, [rows]);

  useFrame((_, delta) => {
    if (!group.current) return;
    const targetY = pointer.current.x * 0.5;
    const targetX = pointer.current.y * 0.3;
    group.current.rotation.y +=
      (targetY - group.current.rotation.y) * Math.min(1, delta * 2) + delta * 0.05;
    group.current.rotation.x +=
      (targetX - group.current.rotation.x) * Math.min(1, delta * 2);
  });

  return (
    <>
      {/* An invisible plane turns the whole canvas into a pointer surface. */}
      <mesh
        onPointerMove={(event) => {
          pointer.current.x = event.pointer.x;
          pointer.current.y = event.pointer.y;
        }}
        visible={false}
        scale={[viewport.width, viewport.height, 1]}
        position={[0, 0, 3]}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>
      <group ref={group}>
        <Shell radius={2.15} />
        {nodes.map((node) => (
          <ChapterNode
            key={node.key}
            position={node.position}
            size={node.size}
            tone={node.tone}
            dimmed={node.dimmed}
            phase={node.phase}
          />
        ))}
      </group>
      <ParticleField />
    </>
  );
}

const ThreatSphere = ({ rows = [], className = "" }) => {
  const [failed, setFailed] = React.useState(false);

  if (failed || !rows.length) {
    return <div className={className} aria-hidden="true" />;
  }

  return (
    <div className={className} aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 6], fov: 42 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onError={() => setFailed(true)}
      >
        <Scene rows={rows} />
      </Canvas>
    </div>
  );
};

export default ThreatSphere;
