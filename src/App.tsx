/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { auth, db, handleFirestoreError, OperationType } from './lib/firebase';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, User } from 'firebase/auth';
import { 
  doc, 
  onSnapshot, 
  setDoc, 
  serverTimestamp, 
  collection, 
  deleteDoc,
  query,
  limit,
  where
} from 'firebase/firestore';
import { LucideGamepad2, LucideUsers, LucideZap, LucideChevronUp, LucideChevronDown, LucideChevronLeft, LucideChevronRight, LucideLogOut, LucideTarget, LucideBarChart3 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---
const ARENA_SIZE = 250;
const SYNC_INTERVAL = 100; 
const PLAYER_SPEED = 20;
const ARENA_WALL_HEIGHT = 40;
const PLAYER_COLORS = ['#3fcfda', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

enum WeaponClass {
  PULSE = 'PULSE',
  SPREAD = 'SPREAD',
  RAIL = 'RAIL'
}

interface WeaponConfig {
  name: string;
  type: WeaponClass;
  damage: number;
  fireRate: number;
  spread: number;
  count: number;
  speed: number;
  color: string;
  recoil: number;
}

const WEAPONS: Record<WeaponClass, WeaponConfig> = {
  [WeaponClass.PULSE]: {
    name: 'V-1 PULSE',
    type: WeaponClass.PULSE,
    damage: 35,
    fireRate: 150,
    spread: 0.05,
    count: 1,
    speed: 130,
    color: '#00f2ff',
    recoil: 3
  },
  [WeaponClass.SPREAD]: {
    name: 'X-5 SPREAD',
    type: WeaponClass.SPREAD,
    damage: 18,
    fireRate: 300,
    spread: 0.3,
    count: 6,
    speed: 95,
    color: '#f43f5e',
    recoil: 7
  },
  [WeaponClass.RAIL]: {
    name: 'Z-LIN RAIL',
    type: WeaponClass.RAIL,
    damage: 250,
    fireRate: 1500,
    spread: 0,
    count: 1,
    speed: 400,
    color: '#3b82f6',
    recoil: 30
  }
};

enum AIState {
  PATROL,
  CHASE
}

enum CameraMode {
  FPS = 'FPS',
  TPS = 'TPS'
}

interface NPC {
  id: string;
  body: CANNON.Body;
  mesh: THREE.Mesh;
  target: THREE.Vector3;
  state: AIState;
  speed: number;
  health: number;
  maxHealth: number;
  lastHitTime: number;
}

interface PlayerState {
  uid: string;
  name: string;
  color: string;
  position: { x: number; y: number; z: number };
  rotationY: number;
  health: number;
  maxHealth: number;
  lastSeen: any;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [remotePlayers, setRemotePlayers] = useState<Record<string, PlayerState>>({});
  const remotePlayersRef = useRef<Record<string, PlayerState>>({});
  const [playerName, setPlayerName] = useState('');
  const [playerColor] = useState(() => PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]);
  const [isJoined, setIsJoined] = useState(false);
  const [isSolo, setIsSolo] = useState(false);
  const [health, setHealth] = useState(100);
  const healthRef = useRef(100);
  const [maxHealth] = useState(100);
  const [achievements, setAchievements] = useState<{id: string, text: string, icon: any}[]>([]);
  const [lastKillTime, setLastKillTime] = useState(0);
  const [killStreak, setKillStreak] = useState(0);

  const addAchievement = useCallback((text: string, icon: any) => {
    const id = Math.random().toString(36).substr(2, 9);
    setAchievements(prev => [...prev, { id, text, icon }]);
    setTimeout(() => {
      setAchievements(prev => prev.filter(a => a.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    healthRef.current = health;
  }, [health]);
  const [isGameOver, setIsGameOver] = useState(false);
  const [activeWeapon, setActiveWeapon] = useState<WeaponClass>(WeaponClass.PULSE);
  const activeWeaponRef = useRef<WeaponClass>(WeaponClass.PULSE);
  const [cameraMode, setCameraMode] = useState<CameraMode>(CameraMode.FPS);
  const cameraModeRef = useRef<CameraMode>(CameraMode.FPS);

  useEffect(() => {
    activeWeaponRef.current = activeWeapon;
  }, [activeWeapon]);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

  const [joystick, setJoystick] = useState({ x: 0, y: 0, active: false });

  const containerRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const mousePosRef = useRef<THREE.Vector2>(new THREE.Vector2());
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const groundPlaneRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    world: CANNON.World;
    playerBody: CANNON.Body;
    playerMesh: THREE.Mesh;
    remoteMeshes: Record<string, THREE.Mesh>;
    keys: Record<string, boolean>;
    npcs: NPC[];
    projectiles: { body: CANNON.Body; mesh: THREE.Mesh; createdAt: number }[];
    fireProjectile: () => void;
  } | null>(null);

  const lastSyncRef = useRef<number>(0);
  const lastDamageRef = useRef<number>(0);
  const lastShotRef = useRef<number>(0);

  // --- Auth Setup ---
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u && !playerName) {
        setPlayerName(u.displayName || `Pilot-${u.uid.slice(0, 4)}`);
      }
      setLoading(false);
    });
  }, [playerName]);

  const joinGame = async () => {
    let currentUser = user;
    if (!currentUser) {
      try {
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        currentUser = result.user;
      } catch (err) {
        console.error("Auth failed", err);
        return;
      }
    }
    setIsJoined(true);
    setIsGameOver(false);
    setHealth(100);
  };

  const handleRespawn = useCallback(() => {
    setHealth(100);
    setIsGameOver(false);
    if (sceneRef.current) {
       sceneRef.current.playerBody.position.set((Math.random() - 0.5) * 10, 5, (Math.random() - 0.5) * 10);
       sceneRef.current.playerBody.velocity.set(0, 0, 0);
    }
  }, []);

  const signOut = () => {
    auth.signOut();
    setIsJoined(false);
  };

  // --- Core Game Loop & Physics ---
  useEffect(() => {
    if (!isJoined || !containerRef.current || !user || isGameOver) return;

    // 1. Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#020617');
    scene.fog = new THREE.FogExp2('#020617', 0.015);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 10, 15);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    containerRef.current.appendChild(renderer.domElement);

    // 2. Physics Setup
    const world = new CANNON.World();
    world.gravity.set(0, -60, 0); // Very strong gravity to prevent floatiness

    // Add solid ground collision
    const groundBody = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Plane(),
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // 3. Lighting
    const ambientLight = new THREE.AmbientLight('#000000', 0.1);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight('#3b82f6', 1.5);
    mainLight.position.set(20, 100, 20);
    scene.add(mainLight);

    // Add neon point lights across the arena
    const neonColors = ['#3b82f6', '#f43f5e', '#8b5cf6', '#10b981'];
    for (let i = 0; i < 6; i++) {
        const pLight = new THREE.PointLight(neonColors[i % neonColors.length], 80, 50);
        pLight.position.set(
            (Math.random() - 0.5) * ARENA_SIZE * 1.2,
            5,
            (Math.random() - 0.5) * ARENA_SIZE * 1.2
        );
        scene.add(pLight);
    }

    // 4. Environment: Floor & Borders & Props
    const grid = new THREE.GridHelper(ARENA_SIZE * 2, 80, '#00f2ff', '#020617');
    grid.position.y = 0.05;
    scene.add(grid);

    const floorGeom = new THREE.PlaneGeometry(ARENA_SIZE * 5, ARENA_SIZE * 5);
    const floorMat = new THREE.MeshStandardMaterial({ 
        color: '#000000', 
        roughness: 0, 
        metalness: 1,
    });
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // 4.1 Physical Arena Walls & Visual Boundary
    const wallMaterial = new THREE.MeshStandardMaterial({ 
      color: '#00f2ff', 
      emissive: '#00f2ff', 
      emissiveIntensity: 1,
      transparent: true,
      opacity: 0.1,
      metalness: 1,
      roughness: 0
    });
    
    const wallHeight = ARENA_WALL_HEIGHT;
    const wallGeom = new THREE.BoxGeometry(ARENA_SIZE * 2, wallHeight, 1);
    
    // Boundary Walls
    const wallPositions = [
        { pos: new CANNON.Vec3(0, wallHeight/2, -ARENA_SIZE), rotY: 0 },
        { pos: new CANNON.Vec3(0, wallHeight/2, ARENA_SIZE), rotY: 0 },
        { pos: new CANNON.Vec3(-ARENA_SIZE, wallHeight/2, 0), rotY: Math.PI / 2 },
        { pos: new CANNON.Vec3(ARENA_SIZE, wallHeight/2, 0), rotY: Math.PI / 2 },
    ];

    wallPositions.forEach(wp => {
        const shape = new CANNON.Box(new CANNON.Vec3(ARENA_SIZE, wallHeight/2, 0.5));
        const body = new CANNON.Body({ mass: 0, shape, position: wp.pos });
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), wp.rotY);
        world.addBody(body);

        const mesh = new THREE.Mesh(wallGeom, wallMaterial);
        mesh.position.set(wp.pos.x, wp.pos.y, wp.pos.z);
        mesh.rotation.y = wp.rotY;
        scene.add(mesh);
    });

    // Add Monolithic Spires
    for (let i = 0; i < 150; i++) {
        const h = 40 + Math.random() * 80;
        const w = 10 + Math.random() * 20;
        const spireGeom = new THREE.BoxGeometry(w, h, w);
        const spireMat = new THREE.MeshStandardMaterial({ 
            color: '#020617',
            emissive: i % 3 === 0 ? '#00f2ff' : (i % 3 === 1 ? '#f43f5e' : '#8b5cf6'),
            emissiveIntensity: 0.8,
            metalness: 1,
            roughness: 0
        });
        const spire = new THREE.Mesh(spireGeom, spireMat);
        
        spire.position.set(
            (Math.random() - 0.5) * ARENA_SIZE * 1.9,
            h / 2,
            (Math.random() - 0.5) * ARENA_SIZE * 1.9
        );
        
        if (spire.position.length() > 30) {
            scene.add(spire);
            const spireBody = new CANNON.Body({
                mass: 0,
                shape: new CANNON.Box(new CANNON.Vec3(w/2, h/2, w/2)),
                position: new CANNON.Vec3(spire.position.x, spire.position.y, spire.position.z)
            });
            world.addBody(spireBody);
        }
    }


    // 5. NPC State Declaration
    const npcs: NPC[] = [];
    const NPC_COUNT = 30;
    const DETECTION_RADIUS = 60;

    // 6. Local Player
    const playerShape = new CANNON.Sphere(1);
    const playerBody = new CANNON.Body({
      mass: 80,
      shape: playerShape,
      position: new CANNON.Vec3((Math.random() - 0.5) * 10, 2, (Math.random() - 0.5) * 10),
      linearDamping: 0.9,
      angularDamping: 0.9,
      fixedRotation: true
    });
    playerBody.allowSleep = false;
    world.addBody(playerBody);

    const playerGroup = new THREE.Group();
    const pMeshGeom = new THREE.IcosahedronGeometry(1.2, 1);
    const pMeshMat = new THREE.MeshStandardMaterial({ 
        color: playerColor, 
        metalness: 0.9, 
        roughness: 0.1,
        emissive: playerColor,
        emissiveIntensity: 0.5
    });
    const pBodyMesh = new THREE.Mesh(pMeshGeom, pMeshMat);
    playerGroup.add(pBodyMesh);

    const thrusterGeom = new THREE.CylinderGeometry(0.4, 0.6, 0.8, 6);
    const thrusterMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#60a5fa', emissiveIntensity: 5 });
    const thruster = new THREE.Mesh(thrusterGeom, thrusterMat);
    thruster.rotation.x = Math.PI / 2;
    thruster.position.z = 0.8;
    playerGroup.add(thruster);

    const playerMesh = playerGroup as any;
    scene.add(playerMesh);

    // Collision Event for damage
    playerBody.addEventListener('collide', (e: any) => {
        const now = Date.now();
        if (now - lastDamageRef.current < 500) return; // Damage cooldown

        const collidedNpc = npcs.find(n => n.body === e.body);
        if (collidedNpc && collidedNpc.health > 0) {
            setHealth(prev => {
                const next = Math.max(0, prev - 10);
                if (next === 0) setIsGameOver(true);
                return next;
            });
            lastDamageRef.current = now;
            
            const dir = new CANNON.Vec3();
            playerBody.position.vsub(collidedNpc.body.position, dir);
            dir.normalize();
            playerBody.applyImpulse(dir.scale(15), playerBody.position);
            
            collidedNpc.health -= 25;
            collidedNpc.lastHitTime = now;
            if (collidedNpc.health <= 0) {
              addAchievement("NPC EXECUTED", LucideTarget);
            }
        }
    });

    // Add glowing ring for local player
    const ringGeom = new THREE.RingGeometry(1.2, 1.3, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: playerColor, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    playerMesh.add(ring);

    // 6. Input Management
    const handleKeyUp = (e: KeyboardEvent) => {
        keysRef.current[e.code] = false;
    };
    const handleMouseMove = (e: MouseEvent) => {
        mousePosRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
        mousePosRef.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    const handleMouseDown = (e: MouseEvent) => {
        if (isJoined && !isGameOver && e.button === 0) fireProjectile();
    };

    const handleWheel = (e: WheelEvent) => {
        const weaponList = Object.values(WeaponClass);
        const currentIndex = weaponList.indexOf(activeWeaponRef.current);
        const nextIndex = e.deltaY > 0 
            ? (currentIndex + 1) % weaponList.length 
            : (currentIndex - 1 + weaponList.length) % weaponList.length;
        setActiveWeapon(weaponList[nextIndex]);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        keysRef.current[e.code] = true;
        if (e.key === '1') setActiveWeapon(WeaponClass.PULSE);
        if (e.key === '2') setActiveWeapon(WeaponClass.SPREAD);
        if (e.key === '3') setActiveWeapon(WeaponClass.RAIL);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('wheel', handleWheel);

    // 8. NPC Initialization
    const projectiles: { body: CANNON.Body; mesh: THREE.Mesh; createdAt: number }[] = [];
    const npcGeometry = new THREE.CapsuleGeometry(1.2, 2.0, 4, 16); 
    for (let i = 0; i < NPC_COUNT; i++) {
        const npcBody = new CANNON.Body({
            mass: 10,
            shape: new CANNON.Sphere(1.5),
            position: new CANNON.Vec3(
                (Math.random() - 0.5) * ARENA_SIZE * 1.5,
                10,
                (Math.random() - 0.5) * ARENA_SIZE * 1.5
            )
        });
        npcBody.linearDamping = 0.6;
        world.addBody(npcBody);

        const npcGroup = new THREE.Group();
        const core = new THREE.Mesh(
            npcGeometry, 
            new THREE.MeshStandardMaterial({ 
                color: '#f43f5e', 
                emissive: '#f43f5e', 
                emissiveIntensity: 2,
                roughness: 0,
                metalness: 1
            })
        );
        npcGroup.add(core);

        const eye = new THREE.Mesh(
            new THREE.SphereGeometry(0.2, 8, 8),
            new THREE.MeshBasicMaterial({ color: '#ffffff' })
        );
        eye.position.set(0, 0.8, 0.8);
        npcGroup.add(eye);

        scene.add(npcGroup);
        
        // NPC UI
        const hbCanvas = document.createElement('canvas');
        hbCanvas.width = 256;
        hbCanvas.height = 64;
        const hbCtx = hbCanvas.getContext('2d')!;
        const hbTexture = new THREE.CanvasTexture(hbCanvas);
        const hbSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: hbTexture }));
        hbSprite.position.y = 3.5;
        hbSprite.scale.set(4, 1, 1);
        npcGroup.add(hbSprite);

        npcs.push({
            id: `npc-${i}`,
            body: npcBody,
            mesh: npcGroup as any,
            target: new THREE.Vector3((Math.random() - 0.5) * ARENA_SIZE, 0, (Math.random() - 0.5) * ARENA_SIZE),
            state: AIState.PATROL,
            speed: 18 + Math.random() * 10,
            health: 400,
            maxHealth: 400,
            lastHitTime: 0
        });
    }


    const fireProjectile = () => {
        const now = Date.now();
        const weapon = WEAPONS[activeWeaponRef.current];
        if (now - lastShotRef.current < weapon.fireRate) return;
        lastShotRef.current = now;

        const aimDir = new THREE.Vector3();
        sceneRef.current.camera.getWorldDirection(aimDir);

        for (let i = 0; i < weapon.count; i++) {
            const spreadX = (Math.random() - 0.5) * weapon.spread;
            const spreadY = (Math.random() - 0.5) * weapon.spread;
            
            const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), aimDir).normalize();
            const up = new THREE.Vector3().crossVectors(aimDir, right).normalize();
            
            const finalDir = aimDir.clone()
                .add(right.clone().multiplyScalar(spreadX))
                .add(up.clone().multiplyScalar(spreadY))
                .normalize();

            const pRadius = weapon.type === WeaponClass.RAIL ? 0.6 : 0.8;
            const projBody = new CANNON.Body({
                mass: 0.1,
                shape: new CANNON.Sphere(pRadius),
                position: new CANNON.Vec3(
                    playerBody.position.x + finalDir.x * 2.5,
                    playerBody.position.y + (cameraModeRef.current === CameraMode.FPS ? 1.2 : 0) + finalDir.y * 2.5,
                    playerBody.position.z + finalDir.z * 2.5
                ),
                velocity: new CANNON.Vec3(finalDir.x * weapon.speed, finalDir.y * weapon.speed, finalDir.z * weapon.speed)
            });
            world.addBody(projBody);

            const projMesh = new THREE.Mesh(
                weapon.type === WeaponClass.RAIL 
                  ? new THREE.CylinderGeometry(0.3, 0.3, 6, 8)
                  : new THREE.SphereGeometry(weapon.type === WeaponClass.SPREAD ? 0.5 : 0.7, 12, 12),
                new THREE.MeshStandardMaterial({ 
                    color: weapon.color,
                    emissive: weapon.color,
                    emissiveIntensity: 6
                })
            );
            if (weapon.type === WeaponClass.RAIL) {
                projMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), finalDir);
            }
            scene.add(projMesh);
            projectiles.push({ body: projBody, mesh: projMesh, createdAt: now });

            // Apply recoil to player (gentle horizontal recoil)
            const recoilForce = finalDir.clone().setY(0).multiplyScalar(-weapon.recoil * 50);
            playerBody.applyForce(new CANNON.Vec3(recoilForce.x, 0, recoilForce.z), playerBody.position);

            // Muzzle Flash
            const flash = new THREE.PointLight(weapon.color, 20, 5);
            flash.position.set(projBody.position.x, projBody.position.y, projBody.position.z);
            scene.add(flash);
            setTimeout(() => scene.remove(flash), 50);

            projBody.addEventListener('collide', (e: any) => {
                const hitNpc = npcs.find(n => n.body === e.body);
                if (hitNpc) {
                    hitNpc.health -= weapon.damage;
                    hitNpc.lastHitTime = Date.now();
                    hitNpc.body.applyImpulse(projBody.velocity.scale(0.1), hitNpc.body.position);
                    
                    if (hitNpc.health <= 0) {
                      addAchievement(`${weapon.name} KILL`, LucideZap);
                      setKillStreak(prev => {
                        const next = prev + 1;
                        if (next % 5 === 0) addAchievement(`${next} KILL STREAK!`, LucideBarChart3);
                        return next;
                      });
                      setLastKillTime(Date.now());
                    }
                }
                
                if (!isSolo) {
                    const meshes = (sceneRef.current?.remoteMeshes || {}) as Record<string, THREE.Mesh>;
                    Object.entries(meshes).forEach(([uid, mesh]) => {
                        const dist = new THREE.Vector3(projBody.position.x, projBody.position.y, projBody.position.z).distanceTo(mesh.position);
                        if (dist < (weapon.type === WeaponClass.SPREAD ? 2.0 : 3.0)) {
                           const victimDoc = doc(db, 'players', uid);
                           const currentHealth = (remotePlayersRef.current as any)[uid]?.health ?? 100;
                           if (currentHealth > 0) {
                              setDoc(victimDoc, { health: Math.max(0, currentHealth - weapon.damage) }, { merge: true });
                           }
                        }
                    });
                }
                projBody.velocity.set(0,0,0);
            });
        }
    };

    sceneRef.current = {
      scene, camera, renderer, world, playerBody, playerMesh, 
      remoteMeshes: {}, keys: keysRef.current, npcs, projectiles,
      fireProjectile
    };

    // 8. Multiplayer Pulse
    const syncToFirebase = async () => {
      if (!user || isSolo) return;
      const pos = playerBody.position;
      try {
        await setDoc(doc(db, 'players', user.uid), {
          uid: user.uid,
          name: playerName,
          color: playerColor,
          position: { x: pos.x, y: pos.y, z: pos.z },
          rotationY: playerMesh.rotation.y,
          lastSeen: serverTimestamp(),
          isActive: true,
          health: health,
          maxHealth: maxHealth
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `players/${user.uid}`);
      }
    };

    // 8. Multiplayer Listener (Remote Players)
    let unsubscribeRemote = () => {};
    if (!isSolo) {
        const q = query(
          collection(db, 'players'), 
          where('isActive', '==', true),
          limit(50)
        );
        unsubscribeRemote = onSnapshot(q, (snapshot) => {
          const players: Record<string, PlayerState> = {};
          snapshot.forEach((doc) => {
            if (doc.id !== user.uid) {
              players[doc.id] = doc.data() as PlayerState;
            }
          });
          setRemotePlayers(players);
          remotePlayersRef.current = players;
        }, (err) => handleFirestoreError(err, OperationType.GET, 'players'));
    }

    // 9. Local Player Health Sync (PVP)
    let unsubscribeSelf = () => {};
    if (!isSolo) {
        unsubscribeSelf = onSnapshot(doc(db, 'players', user.uid), (snap) => {
          if (snap.exists()) {
            const data = snap.data() as PlayerState;
            if (data.health !== undefined && data.health < health) {
              setHealth(data.health);
              if (data.health <= 0 && !isGameOver) {
                setIsGameOver(true);
              }
            }
          }
        }, (err) => handleFirestoreError(err, OperationType.GET, `players/${user.uid}`));
    }

    // 10. Animation Loop
    let animationFrameId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      world.step(1/60, delta, 3);

      // Physics Move
      const keys = keysRef.current;
      const isSprinting = keys['ShiftLeft'] || keys['ShiftRight'];
      const MOVE_STRENGTH = isSprinting ? 120 : 80;
      
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      camDir.y = 0; 
      camDir.normalize();
      
      const forward = camDir.clone();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).negate(); 
      
      const forceVec = new THREE.Vector3();

      if (keys['KeyW'] || keys['ArrowUp'] || joystick.y < -0.2) forceVec.add(forward.multiplyScalar(joystick.active ? Math.abs(joystick.y) : 1));
      if (keys['KeyS'] || keys['ArrowDown'] || joystick.y > 0.2) forceVec.sub(forward.multiplyScalar(joystick.active ? Math.abs(joystick.y) : 1));
      if (keys['KeyA'] || keys['ArrowLeft'] || joystick.x < -0.2) forceVec.sub(right.multiplyScalar(joystick.active ? Math.abs(joystick.x) : 1));
      if (keys['KeyD'] || keys['ArrowRight'] || joystick.x > 0.2) forceVec.add(right.multiplyScalar(joystick.active ? Math.abs(joystick.x) : 1));

      if (forceVec.length() > 0) {
        forceVec.normalize().multiplyScalar(MOVE_STRENGTH);
        // More direct control for better response
        const targetVelX = forceVec.x;
        const targetVelZ = forceVec.z;
        playerBody.velocity.x += (targetVelX - playerBody.velocity.x) * 0.3;
        playerBody.velocity.z += (targetVelZ - playerBody.velocity.z) * 0.3;
      }

      // Stronger downward force to keep grounded
      playerBody.applyForce(new CANNON.Vec3(0, -100, 0), playerBody.position);

      // Aiming (Mouse Raycasting) - Only for TPS/Top-down or when needed
      if (cameraModeRef.current !== CameraMode.FPS) {
        raycasterRef.current.setFromCamera(mousePosRef.current, camera);
        const intersectPoint = new THREE.Vector3();
        raycasterRef.current.ray.intersectPlane(groundPlaneRef.current, intersectPoint);
        
        if (intersectPoint) {
           const dx = intersectPoint.x - playerBody.position.x;
           const dz = intersectPoint.z - playerBody.position.z;
           const targetRotation = Math.atan2(dx, dz) + Math.PI;
           
           let diff = targetRotation - playerMesh.rotation.y;
           while (diff < -Math.PI) diff += Math.PI * 2;
           while (diff > Math.PI) diff -= Math.PI * 2;
           playerMesh.rotation.y += diff * 0.2;
        }
      }

      // Jump (Space)
      if (keys['Space'] && Math.abs(playerBody.velocity.y) < 0.1) {
          playerBody.applyImpulse(new CANNON.Vec3(0, 8, 0), playerBody.position);
          keys['Space'] = false;
      }

      // Mesh sync
      playerMesh.position.copy(playerBody.position as any);
      
      // Tilt based on velocity
      const vel = playerBody.velocity;
      playerMesh.rotation.z = -vel.x * 0.05;
      playerMesh.rotation.x = vel.z * 0.05;

      // Arena constraints
      if (Math.abs(playerBody.position.x) > ARENA_SIZE) {
        playerBody.position.x = Math.sign(playerBody.position.x) * ARENA_SIZE;
        playerBody.velocity.x *= -0.5;
      }
      if (Math.abs(playerBody.position.z) > ARENA_SIZE) {
        playerBody.position.z = Math.sign(playerBody.position.z) * ARENA_SIZE;
        playerBody.velocity.z *= -0.5;
      }
      if (playerBody.position.y < -10) {
        playerBody.position.set(0, 5, 0);
        playerBody.velocity.set(0, 0, 0);
      }

      // Camera & Rotation logic
      if (cameraModeRef.current === CameraMode.FPS) {
        // High-Precision FPS Camera
        const yaw = -mousePosRef.current.x * Math.PI * 2;
        const pitch = -mousePosRef.current.y * Math.PI * 0.45; // Slightly more vertical range
        
        // Instant response for FPS
        camera.position.set(playerBody.position.x, playerBody.position.y + 1.2, playerBody.position.z);
        
        const lookDirection = new THREE.Vector3(
          Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          Math.cos(yaw) * Math.cos(pitch)
        );
        
        const lookAtTarget = new THREE.Vector3().copy(camera.position).add(lookDirection);
        camera.lookAt(lookAtTarget);

        playerMesh.rotation.y = yaw;
        playerMesh.visible = false; 
      } else {
        playerMesh.visible = true;
        // Cinematic TPS Follow
        const yaw = -mousePosRef.current.x * Math.PI * 2;
        
        const offset = new THREE.Vector3(0, 8, 22); // Further back for better visibility
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        
        const targetPos = new THREE.Vector3(
          playerBody.position.x + offset.x,
          playerBody.position.y + offset.y,
          playerBody.position.z + offset.z
        );
        
        // Smoother interpolation for TPS feel
        camera.position.lerp(targetPos, 0.15);
        
        const lookAtPoint = new THREE.Vector3(
          playerBody.position.x,
          playerBody.position.y + 2.5,
          playerBody.position.z
        );
        camera.lookAt(lookAtPoint);

        playerMesh.rotation.y = yaw;
      }

      // Projectiles update
      const now = Date.now();
      projectiles.forEach((p, idx) => {
          p.mesh.position.copy(p.body.position as any);
          if (now - p.createdAt > 2000) {
              scene.remove(p.mesh);
              world.removeBody(p.body);
              projectiles.splice(idx, 1);
          }
      });

      // Update coords UI
      const coordEl = document.getElementById('coord-display');
      if (coordEl) {
        coordEl.textContent = `X${playerBody.position.x.toFixed(2)} Y${playerBody.position.y.toFixed(2)} Z${playerBody.position.z.toFixed(2)}`;
      }

      // NPC AI Update
      npcs.forEach(npc => {
        if (npc.health <= 0) {
            // Respawn logic
            if (Date.now() - npc.lastHitTime > 3000) {
                npc.health = 100;
                npc.body.position.set((Math.random() - 0.5) * ARENA_SIZE, 10, (Math.random() - 0.5) * ARENA_SIZE);
                npc.mesh.scale.set(1, 1, 1);
                npc.mesh.visible = true;
            } else {
                npc.mesh.scale.set(0.5, 0.5, 0.5);
                npc.mesh.visible = false;
                npc.body.position.y = -10; // Keep it out of sight
            }
            return;
        }

        const npcPos = new THREE.Vector3(npc.body.position.x, npc.body.position.y, npc.body.position.z);
        
        // Find closest ACTIVE target
        let closestTarget: THREE.Vector3 | null = null;
        let minDist = Infinity;

        // Check local player if alive
        if (healthRef.current > 0) {
            const playerPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z);
            minDist = npcPos.distanceTo(playerPos);
            closestTarget = playerPos;
        }

        // Check remote players if alive
        Object.values(remotePlayersRef.current as Record<string, PlayerState>).forEach((p: PlayerState) => {
          if (p.health > 0) {
            const pPos = new THREE.Vector3(p.position.x, p.position.y, p.position.z);
            const d = npcPos.distanceTo(pPos);
            if (d < minDist) {
              minDist = d;
              closestTarget = pPos;
            }
          }
        });

        const speed = npc.state === AIState.CHASE ? 22 : 12;
        const steeringForce = new THREE.Vector3();

        // State Machine & Logic
        if (closestTarget && minDist < DETECTION_RADIUS) {
          npc.state = AIState.CHASE;
          
          // Predictive leading: Move towards where the player is going
          const predictionScale = 0.15;
          const predictedTarget = closestTarget.clone();
          
          const playerPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z);
          if (closestTarget.equals(playerPos)) {
             predictedTarget.add(new THREE.Vector3(playerBody.velocity.x, 0, playerBody.velocity.z).multiplyScalar(predictionScale));
          }

          const chaseDir = new THREE.Vector3().subVectors(predictedTarget, npcPos).normalize();
          steeringForce.copy(chaseDir);
          
          // Tactical Dash
          if (minDist < 15 && Math.random() > 0.98) {
             npc.body.velocity.x += chaseDir.x * 40;
             npc.body.velocity.z += chaseDir.z * 40;
          }
        } else {
          npc.state = AIState.PATROL;
          
          // Wander behavior: pick a new direction periodically or if near a target
          if (!npc.target || npcPos.distanceTo(npc.target) < 4) {
             const wanderAngle = Math.random() * Math.PI * 2;
             const wanderRadius = 15;
             npc.target.set(
               Math.max(-ARENA_SIZE, Math.min(ARENA_SIZE, npcPos.x + Math.cos(wanderAngle) * wanderRadius)),
               0,
               Math.max(-ARENA_SIZE, Math.min(ARENA_SIZE, npcPos.z + Math.sin(wanderAngle) * wanderRadius))
             );
          }
          const wanderDir = new THREE.Vector3().subVectors(npc.target, npcPos).normalize();
          steeringForce.copy(wanderDir);
        }

        // --- Obstacle & Boundary Avoidance ---
        // 1. Map Boundaries
        const distFromCenter = npcPos.length();
        if (distFromCenter > ARENA_SIZE * 0.8) {
           const avoidCenter = new THREE.Vector3().copy(npcPos).negate().normalize();
           steeringForce.add(avoidCenter.multiplyScalar(2.0));
        }

        // 2. Dodge Projectiles (Intelligence)
        projectiles.forEach(p => {
          const pPos = new THREE.Vector3(p.body.position.x, p.body.position.y, p.body.position.z);
          const pVel = new THREE.Vector3(p.body.velocity.x, p.body.velocity.y, p.body.velocity.z);
          const toProjectile = new THREE.Vector3().subVectors(npcPos, pPos);
          const dot = toProjectile.normalize().dot(pVel.normalize());
          
          if (dot > 0.8 && npcPos.distanceTo(pPos) < 15) {
             const sideDir = new THREE.Vector3(-pVel.z, 0, pVel.x).normalize();
             steeringForce.add(sideDir.multiplyScalar(5.0));
          }
        });

        // 3. Coordinate with other NPCs (Pack hunting)
        npcs.forEach(other => {
           if (other === npc || other.health <= 0) return;
           const otherPos = new THREE.Vector3(other.body.position.x, other.body.position.y, other.body.position.z);
           const dist = npcPos.distanceTo(otherPos);
           if (dist < 6) {
              const repel = new THREE.Vector3().subVectors(npcPos, otherPos).normalize();
              steeringForce.add(repel.multiplyScalar(4.0 / dist));
           }
        });

        // 4. Evasive maneuvers if low health
        if (npc.health < 40 && closestTarget) {
           const fleeDir = new THREE.Vector3().subVectors(npcPos, closestTarget).normalize();
           steeringForce.add(fleeDir.multiplyScalar(3.0));
        }

        // 3. Avoid Players if patrolling but too close
        if (npc.state === AIState.PATROL && closestTarget && minDist < 10) {
           const repelPlayer = new THREE.Vector3().subVectors(npcPos, closestTarget).normalize();
           steeringForce.add(repelPlayer.multiplyScalar(2.0));
        }

        // Apply steering
        steeringForce.normalize();
        npc.body.applyForce(new CANNON.Vec3(steeringForce.x * speed, 0, steeringForce.z * speed), npc.body.position);
        
        // Horizontal stabilization
        npc.body.velocity.x *= 0.95;
        npc.body.velocity.z *= 0.95;

        // Visuals
        npc.mesh.position.copy(npc.body.position as any);
        
        // Safety Respawn if falling
        if (npc.body.position.y < -20) {
           npc.body.position.set((Math.random() - 0.5) * ARENA_SIZE, 10, (Math.random() - 0.5) * ARENA_SIZE);
           npc.body.velocity.set(0, 0, 0);
        }

        // Smooth Rotation
        if (steeringForce.length() > 0.01) {
           const targetRotation = Math.atan2(steeringForce.x, steeringForce.z);
           let diff = targetRotation - npc.mesh.rotation.y;
           while (diff < -Math.PI) diff += Math.PI * 2;
           while (diff > Math.PI) diff -= Math.PI * 2;
           npc.mesh.rotation.y += diff * 0.1;
        }

        npc.mesh.rotation.x += delta * 0.5;

        // Update NPC UI (Name + Health)
        const hbSprite = npc.mesh.children.find(c => c instanceof THREE.Sprite) as THREE.Sprite;
        if (hbSprite) {
            const canvas = (hbSprite.material as THREE.SpriteMaterial).map!.image as HTMLCanvasElement;
            const ctx = canvas.getContext('2d')!;
            ctx.clearRect(0, 0, 256, 64);
            
            // Neon Name Tag
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 28px monospace';
            ctx.textAlign = 'center';
            ctx.shadowBlur = 10;
            ctx.shadowColor = npc.state === AIState.CHASE ? '#f43f5e' : '#00f2ff';
            ctx.fillText(`UNIT_${npc.id.split('-')[1]}`, 128, 30);
            ctx.shadowBlur = 0;

            // Health Bar
            const barW = 180;
            const barH = 12;
            const barX = (256 - barW) / 2;
            const barY = 40;
            
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(barX, barY, barW, barH);
            
            ctx.fillStyle = npc.state === AIState.CHASE ? '#f43f5e' : '#00f2ff';
            ctx.fillRect(barX, barY, barW * (npc.health / npc.maxHealth), barH);
            
            (hbSprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
        }

        // Pulse rings and cores
        npc.mesh.children.forEach(c => {
            if (c instanceof THREE.Mesh && c.geometry instanceof THREE.TorusGeometry) {
                c.rotation.z += delta;
                c.scale.setScalar(1 + Math.sin(Date.now() * 0.005) * 0.1);
            }
        });

        // Visual feedback for state
        const mat = (npc.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (npc.state === AIState.CHASE) {
          mat.emissiveIntensity = 3 + Math.sin(Date.now() * 0.015) * 2;
          mat.emissive.set('#ef4444');
        } else {
          mat.emissiveIntensity = 1 + Math.sin(Date.now() * 0.005) * 0.5;
          mat.emissive.set(playerColor); 
        }
      });

      // Sync frequency
      if (now - lastSyncRef.current > SYNC_INTERVAL) {
        syncToFirebase();
        lastSyncRef.current = now;
      }

      renderer.render(scene, camera);
    };

    animate();

    // 10. Resize
    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      unsubscribeRemote();
      unsubscribeSelf();
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
      // Cleanup player from DB
      if (user) {
        deleteDoc(doc(db, 'players', user.uid)).catch(console.error);
      }
    };
  }, [isJoined, user, playerName, playerColor]);

  // Handle remote player meshes
  useEffect(() => {
    if (!sceneRef.current || !isJoined) return;
    const { scene, remoteMeshes } = sceneRef.current;

    // Remove stale meshes
    Object.keys(remoteMeshes).forEach((uid) => {
      if (!remotePlayers[uid]) {
        scene.remove(remoteMeshes[uid]);
        delete remoteMeshes[uid];
      }
    });

    // Add or update meshes
    Object.entries(remotePlayers as Record<string, PlayerState>).forEach(([uid, data]) => {
      let mesh = remoteMeshes[uid];
      if (!mesh) {
        const group = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.IcosahedronGeometry(1.2, 1),
            new THREE.MeshStandardMaterial({ color: data.color, metalness: 0.9, roughness: 0.1, emissive: data.color, emissiveIntensity: 0.5 })
        );
        group.add(body);
        
        const thruster = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.6, 0.8, 6),
            new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#60a5fa', emissiveIntensity: 5 })
        );
        thruster.rotation.x = Math.PI / 2;
        thruster.position.z = 0.8;
        group.add(thruster);

        mesh = group as any;
        scene.add(mesh);
        remoteMeshes[uid] = mesh;

        // Label
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0,0,256,64);
        ctx.font = 'bold 32px Inter, sans-serif';
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.fillText(data.name, 128, 48);
        
        const textTex = new THREE.CanvasTexture(canvas);
        const textMat = new THREE.SpriteMaterial({ map: textTex });
        const sprite = new THREE.Sprite(textMat);
        sprite.position.y = 2;
        sprite.scale.set(4, 1, 1);
        mesh.add(sprite);

        // Health Bar (Nested in sprite)
        const hbCanvas = document.createElement('canvas');
        hbCanvas.width = 128;
        hbCanvas.height = 16;
        const hbTex = new THREE.CanvasTexture(hbCanvas);
        const hbMat = new THREE.SpriteMaterial({ map: hbTex });
        const hbSprite = new THREE.Sprite(hbMat);
        hbSprite.position.y = 1.2;
        hbSprite.scale.set(2, 0.25, 1);
        sprite.add(hbSprite);
      }

      mesh.position.lerp(new THREE.Vector3(data.position.x, data.position.y, data.position.z), 0.2);
      mesh.rotation.y = data.rotationY;

      // Update Health Bar
      const sprite = mesh.children.find(c => c instanceof THREE.Sprite) as THREE.Sprite;
      const hbSprite = sprite?.children.find(c => c instanceof THREE.Sprite) as THREE.Sprite;
      if (hbSprite) {
          const canvas = (hbSprite.material as THREE.SpriteMaterial).map!.image as HTMLCanvasElement;
          const ctx = canvas.getContext('2d')!;
          ctx.clearRect(0, 0, 128, 16);
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.fillRect(0, 0, 128, 16);
          ctx.fillStyle = '#10b981';
          ctx.fillRect(0, 0, (data.health / data.maxHealth) * 128, 16);
          (hbSprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
      }
    });
  }, [remotePlayers, isJoined]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-white">
        <LucideZap className="h-8 w-8 animate-pulse text-blue-500" />
      </div>
    );
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-slate-950 font-sans selection:bg-blue-500/30">
        {/* Targeting Reticle */}
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
            <div className="relative h-10 w-10">
                <div className="absolute inset-0 rounded-full border-2 border-cyan-500/30 shadow-[0_0_15px_rgba(6,182,212,0.3)]" />
                <div className="absolute left-1/2 top-0 h-3 w-0.5 -translate-x-1/2 bg-cyan-400" />
                <div className="absolute bottom-0 left-1/2 h-3 w-0.5 -translate-x-1/2 bg-cyan-400" />
                <div className="absolute left-0 top-1/2 h-0.5 w-3 -translate-y-1/2 bg-cyan-400" />
                <div className="absolute right-0 top-1/2 h-0.5 w-3 -translate-y-1/2 bg-cyan-400" />
                <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_8px_white]" />
            </div>
        </div>

        {/* Global Alerts */}
        <AnimatePresence>
            {health <= 0 && (
                <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute inset-0 z-[100] flex flex-col items-center justify-center bg-red-950/40 backdrop-blur-md"
                >
                    <motion.h2 
                      initial={{ scale: 2, y: -50 }}
                      animate={{ scale: 1, y: 0 }}
                      className="text-8xl font-black italic tracking-tighter text-red-500 drop-shadow-[0_0_40px_rgba(239,68,68,0.9)]"
                    >
                        SYSTEM DISABLED
                    </motion.h2>
                    <motion.p 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="mt-6 text-2xl font-bold tracking-[0.5em] text-white/60"
                    >
                        CRITICAL HARDWARE FAILURE
                    </motion.p>
                </motion.div>
            )}
        </AnimatePresence>
      <div ref={containerRef} className="absolute inset-0" id="game-canvas" />

      {/* Game Over Screen */}
      {isGameOver && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-red-950/90 backdrop-blur-md">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center">
            <h2 className="text-6xl font-black italic tracking-tighter text-white mb-2">SYSTEM FAILURE</h2>
            <p className="text-red-400 font-mono text-sm tracking-widest uppercase mb-8 underline decoration-red-800 underline-offset-8">Vessel Integrity Critical - Data Purged</p>
            <button 
              onClick={handleRespawn}
              className="group relative overflow-hidden rounded-full bg-white px-12 py-4 font-black tracking-widest text-black transition-all hover:scale-110 active:scale-95"
            >
              RE-INITIATE SEQUENCE
            </button>
          </motion.div>
        </div>
      )}

      {/* Crosshair */}
      {isJoined && !isGameOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
           <motion.div 
             key={activeWeapon}
             animate={{ 
               scale: [1, 1.4, 1],
               rotate: activeWeapon === WeaponClass.RAIL ? 45 : 0
             }}
             transition={{ duration: 0.15 }}
             className="relative h-12 w-12"
           >
              {/* Outer Corners */}
              <div className="absolute top-0 left-0 h-3 w-3 border-t-2 border-l-2 border-white/40" />
              <div className="absolute top-0 right-0 h-3 w-3 border-t-2 border-r-2 border-white/40" />
              <div className="absolute bottom-0 left-0 h-3 w-3 border-b-2 border-l-2 border-white/40" />
              <div className="absolute bottom-0 right-0 h-3 w-3 border-b-2 border-r-2 border-white/40" />
              
              {/* Center Dot */}
              <div 
                className="absolute top-1/2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_10px_rgba(255,255,255,0.8)]" 
                style={{ backgroundColor: WEAPONS[activeWeapon].color }}
              />
              
              {/* Weapon Name Label */}
              <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap">
                 <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">{WEAPONS[activeWeapon].name}</span>
              </div>
           </motion.div>
        </div>
      )}

      {/* Weapon HUD */}
      {isJoined && !isGameOver && (
        <div className="absolute bottom-12 left-1/2 z-20 flex -translate-x-1/2 gap-4">
           {Object.values(WEAPONS).map((w) => (
              <button
                key={w.type}
                onClick={() => setActiveWeapon(w.type)}
                onTouchStart={() => setActiveWeapon(w.type)}
                className={`group relative flex flex-col items-center gap-1 overflow-hidden rounded-xl border-2 px-6 py-3 transition-all ${
                  activeWeapon === w.type 
                  ? 'border-blue-500 bg-blue-500/20 scale-110 shadow-[0_0_20px_rgba(59,130,246,0.3)]' 
                  : 'border-white/5 bg-slate-900/80 text-slate-500 hover:border-white/20'
                }`}
              >
                 <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                 <span className="text-[9px] font-black tracking-widest opacity-40">MK_{w.type}</span>
                 <span className={`text-xs font-black uppercase tracking-widest ${activeWeapon === w.type ? 'text-white' : 'text-slate-500'}`}>
                    {w.name}
                 </span>
                 {activeWeapon === w.type && (
                    <motion.div 
                      layoutId="weapon-glow"
                      className="absolute inset-0 z-[-1] bg-blue-500/10 blur-xl"
                    />
                 )}
                 <div 
                   className="mt-1 h-1 w-full rounded-full transition-all" 
                   style={{ 
                     backgroundColor: w.color, 
                     opacity: activeWeapon === w.type ? 1 : 0.2,
                     boxShadow: activeWeapon === w.type ? `0 0 10px ${w.color}` : 'none'
                   }} 
                 />
              </button>
           ))}
        </div>
      )}

      {/* Mobile Controls */}
      {isJoined && !isGameOver && (
        <div className="absolute bottom-12 left-12 right-12 z-20 flex justify-between lg:hidden">
          {/* Joystick */}
          <div 
            className="relative h-32 w-32 rounded-full border-2 border-white/10 bg-white/5 backdrop-blur-sm touch-none"
            onTouchStart={(e) => {
               const touch = e.touches[0];
               const rect = e.currentTarget.getBoundingClientRect();
               const x = (touch.clientX - rect.left - 64) / 64;
               const y = (touch.clientY - rect.top - 64) / 64;
               setJoystick({ x, y, active: true });
            }}
            onTouchMove={(e) => {
               const touch = e.touches[0];
               const rect = e.currentTarget.getBoundingClientRect();
               const x = Math.max(-1, Math.min(1, (touch.clientX - rect.left - 64) / 64));
               const y = Math.max(-1, Math.min(1, (touch.clientY - rect.top - 64) / 64));
               setJoystick({ x, y, active: true });
            }}
            onTouchEnd={() => setJoystick({ x: 0, y: 0, active: false })}
          >
            <motion.div 
               animate={{ x: joystick.x * 32, y: joystick.y * 32 }}
               className="absolute top-1/2 left-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500 shadow-lg shadow-blue-500/50" 
            />
          </div>

          {/* Fire Button */}
          <button 
            onTouchStart={() => sceneRef.current?.fireProjectile()}
            className="h-24 w-24 rounded-full border-4 border-red-500/30 bg-red-500/20 text-red-500 backdrop-blur-md active:scale-90 active:bg-red-500/40"
          >
            <span className="text-xs font-black uppercase tracking-widest">FIRE</span>
          </button>
        </div>
      )}

      {/* Overlay UI */}
      {!isJoined ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-slate-900 p-8 shadow-2xl"
          >
            <div className="mb-6 flex flex-col items-center">
              <div className="mb-4 rounded-2xl bg-blue-500/20 p-4">
                <LucideGamepad2 className="h-10 w-10 text-blue-500" />
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white">Neon Arena 3D</h1>
              <p className="mt-2 text-slate-400">Battle across the neon grid</p>
            </div>

            <div className="space-y-4 px-4 pb-4">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Pilot Designation</label>
                <input 
                  type="text" 
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 p-4 font-mono text-white placeholder:text-slate-700 focus:border-blue-500/50 focus:outline-none focus:ring-4 focus:ring-blue-500/10"
                  placeholder="Enter callsign..."
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                 <button 
                  onClick={() => setIsSolo(true)}
                  className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-all ${isSolo ? 'border-blue-500 bg-blue-500/20 text-blue-400' : 'border-white/5 bg-white/5 text-slate-500 hover:bg-white/10'}`}
                 >
                    <LucideZap className="h-6 w-6" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Solo Training</span>
                 </button>
                 <button 
                  onClick={() => setIsSolo(false)}
                  className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-all ${!isSolo ? 'border-purple-500 bg-purple-500/20 text-purple-400' : 'border-white/5 bg-white/5 text-slate-500 hover:bg-white/10'}`}
                 >
                    <LucideUsers className="h-6 w-6" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Multi Network</span>
                 </button>
              </div>

              <div className="flex items-center gap-3 rounded-lg bg-white/5 p-2">
                 <div className="h-4 w-4 rounded-full" style={{ backgroundColor: playerColor }} />
                 <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">Core Signal: {playerColor}</span>
              </div>

              <button 
                onClick={joinGame}
                className="group relative w-full overflow-hidden rounded-xl bg-blue-600 px-6 py-4 font-bold text-white transition-all hover:bg-blue-500 active:scale-95"
              >
                <span className="relative z-10 flex items-center justify-center gap-2">
                  Initiate System <LucideZap className="h-4 w-4" />
                </span>
                <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
              </button>
            </div>

            <div className="mt-8 flex justify-center gap-6 border-t border-white/5 pt-6 text-[10px] font-medium uppercase tracking-widest text-slate-600">
               <div className="flex items-center gap-1"><LucideUsers className="h-3 w-3" /> Real-time active</div>
               <div className="flex items-center gap-1"><LucideZap className="h-3 w-3" /> Low Latency Sync</div>
            </div>
          </motion.div>
        </div>
      ) : (
        <>
          {/* HUD - Technical Instrument Style */}
          <div className="pointer-events-none absolute inset-0 z-10 p-6">
            <div className="flex w-full justify-between items-start">
              {/* Left Wing: Pilot Info */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 rounded-t-lg border-x border-t border-white/20 bg-slate-900/80 px-3 py-1 backdrop-blur-md">
                   <LucideTarget className="h-3 w-3 text-blue-400" />
                   <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 font-mono">Telemetry Active</span>
                </div>
                <div className="rounded-b-lg rounded-tr-lg border border-white/20 bg-slate-900/40 p-4 backdrop-blur-md">
                   <div className="flex items-center gap-4">
                      <div className="relative">
                         <div className="h-12 w-12 rounded-full border-2 border-white/10 p-1">
                            <div className="h-full w-full rounded-full animate-pulse" style={{ backgroundColor: playerColor }} />
                         </div>
                         <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-slate-900 bg-green-500" />
                      </div>
                      <div>
                         <div className="flex items-center gap-2">
                            <p className="text-[10px] font-bold uppercase tracking-tighter text-slate-500 font-mono">Vessel Designation</p>
                            <span className={`rounded-sm px-1 text-[8px] font-black uppercase ${isSolo ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
                               {isSolo ? 'LOCAL_CHNL' : 'NET_CORE'}
                            </span>
                         </div>
                         <p className="text-lg font-bold tracking-tight text-white leading-none">{playerName}</p>
                         
                         {/* Health Bar In HUD */}
                         <div className="mt-3 w-48 overflow-hidden rounded-full bg-slate-800 p-0.5 border border-white/5">
                            <div 
                               className="h-2 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 transition-all duration-300"
                               style={{ width: `${(health / maxHealth) * 100}%` }}
                            />
                         </div>
                         <p className="mt-1 text-[10px] font-bold text-slate-400 font-mono">INTEGRITY: {health}%</p>
                      </div>
                   </div>
                </div>
              </div>

              {/* Right Wing: Arena Status */}
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2 rounded-t-lg border-x border-t border-white/20 bg-slate-900/80 px-3 py-1 backdrop-blur-md">
                   <LucideBarChart3 className="h-3 w-3 text-blue-400" />
                   <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 font-mono">Arena Load</span>
                </div>
                <div className="flex items-center gap-4 rounded-b-lg rounded-tl-lg border border-white/20 bg-slate-900/40 p-4 backdrop-blur-md">
                  <div className="text-right">
                    <p className="text-[10px] font-bold uppercase tracking-tighter text-slate-500 font-mono">Active Signals</p>
                    <p className="text-xl font-black text-white font-mono leading-none">
                       {String(Object.keys(remotePlayers).length + 1).padStart(2, '0')}
                    </p>
                  </div>
                  <div className="h-8 w-px bg-white/10" />
                  <button 
                    onClick={signOut}
                    className="pointer-events-auto group relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 transition-all hover:bg-red-500/20 hover:border-red-500/50"
                  >
                    <LucideLogOut className="h-4 w-4 text-slate-400 transition-colors group-hover:text-red-400" />
                  </button>
                </div>
              </div>
            </div>

          {/* Bottom Status Bar */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-8 rounded-full border border-white/10 bg-slate-900/60 px-8 py-3 backdrop-blur-xl">
               <div className="flex items-center gap-2">
                 <div className="h-2 w-2 rounded-full bg-blue-500" />
                 <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300 font-mono">System Integrity High</span>
               </div>
               <div className="h-4 w-px bg-white/10" />
               <div className="flex items-center gap-2">
                 <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-mono">Coord:</span>
                 <span id="coord-display" className="text-[10px] font-bold text-white font-mono">X0.00 Y0.00 Z0.00</span>
               </div>
            </div>
          </div>

          {/* Camera & Settings Toggle */}
          <div className="absolute top-6 left-6 z-[60] flex gap-2">
            <button
              onClick={() => setCameraMode(prev => prev === CameraMode.FPS ? CameraMode.TPS : CameraMode.FPS)}
              className="group flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/80 px-4 py-2 backdrop-blur-md transition-all hover:border-blue-500/50"
            >
              {cameraMode === CameraMode.FPS ? <LucideTarget className="h-4 w-4 text-blue-400" /> : <LucideUsers className="h-4 w-4 text-emerald-400" />}
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">
                View: {cameraMode}
              </span>
            </button>
          </div>
          <div className="absolute top-24 left-1/2 z-[60] -translate-x-1/2 flex flex-col gap-2 pointer-events-none">
            <AnimatePresence>
               {achievements.map((ach) => (
                 <motion.div
                   key={ach.id}
                   initial={{ opacity: 0, y: -20, scale: 0.8 }}
                   animate={{ opacity: 1, y: 0, scale: 1 }}
                   exit={{ opacity: 0, x: 20 }}
                   className="flex items-center gap-3 rounded-full border border-yellow-500/50 bg-slate-900/90 px-6 py-2 shadow-[0_0_20px_rgba(234,179,8,0.2)] backdrop-blur-md"
                 >
                   <ach.icon className="h-4 w-4 text-yellow-500" />
                   <span className="text-xs font-black uppercase tracking-[0.2em] text-white">{ach.text}</span>
                 </motion.div>
               ))}
            </AnimatePresence>
          </div>

          {/* Controls Help */}
          <div className="pointer-events-none absolute bottom-6 right-6 z-10 space-y-2 text-right">
             <div className="inline-flex gap-2 rounded-lg border border-white/10 bg-slate-900/50 p-2 backdrop-blur-sm">
                <kbd className="h-8 rounded bg-white/10 flex items-center justify-center px-2 text-[10px] text-white font-bold">SHIFT TO SPRINT</kbd>
                <kbd className="h-8 w-8 rounded bg-white/10 flex items-center justify-center text-xs text-white">W</kbd>
                <kbd className="h-8 w-8 rounded bg-white/10 flex items-center justify-center text-xs text-white">A</kbd>
                <kbd className="h-8 w-8 rounded bg-white/10 flex items-center justify-center text-xs text-white">S</kbd>
                <kbd className="h-8 w-8 rounded bg-white/10 flex items-center justify-center text-xs text-white">D</kbd>
             </div>
             <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Navigation Controls</p>
          </div>

          {/* Mobile Controls (Visible on small screens) */}
          <div className="absolute bottom-6 left-6 z-20 md:hidden flex flex-col gap-2">
             <div className="flex gap-2">
                <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center active:bg-blue-500/50" onTouchStart={() => sceneRef.current!.keys['KeyW'] = true} onTouchEnd={() => sceneRef.current!.keys['KeyW'] = false}>
                   <LucideChevronUp className="text-white"/>
                </div>
             </div>
             <div className="flex gap-2">
                <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center active:bg-blue-500/50" onTouchStart={() => sceneRef.current!.keys['KeyA'] = true} onTouchEnd={() => sceneRef.current!.keys['KeyA'] = false}>
                   <LucideChevronLeft className="text-white"/>
                </div>
                <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center active:bg-blue-500/50" onTouchStart={() => sceneRef.current!.keys['KeyS'] = true} onTouchEnd={() => sceneRef.current!.keys['KeyS'] = false}>
                   <LucideChevronDown className="text-white"/>
                </div>
                <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center active:bg-blue-500/50" onTouchStart={() => sceneRef.current!.keys['KeyD'] = true} onTouchEnd={() => sceneRef.current!.keys['KeyD'] = false}>
                   <LucideChevronRight className="text-white"/>
                </div>
             </div>
          </div>
        </>
      )}
    </main>
  );
}
