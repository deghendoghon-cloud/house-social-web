import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const canvas = document.getElementById('c');
export const hud = document.getElementById('hud');
export const errEl = document.getElementById('err');

export const api = {};
export const state = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  roomRoot: null,
  selectedId: null,
  ready: false,
  lastSceneKey: '',
  editMode: false,
  dragTarget: null,
  dragOffset: new THREE.Vector3(),
  dragPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  dragOrigin: null,
  dragWasInvalid: false,
  pointerDownPos: null,
  longPressTimer: null,
  longPressTarget: null,
};

export const selectable = new Map();
export const gltfLoader = new GLTFLoader();
export const gltfCache = new Map();
export const activeTvVideos = [];
export const activeTvTextures = [];
export const _texCache = new Map();
export const LONG_PRESS_MS = 5000;

export const PALETTE = {
  floor: 0xc4a574,
  floorEdge: 0x8d7355,
  wall: 0xe8e0d5,
  wallEdge: 0xb8a990,
  door: 0x6d4c41,
  roomWall: 0xd5c8b8,
  bg: 0x1e2228,
};

export { THREE };
