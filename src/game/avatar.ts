import * as THREE from "three";

export interface CombatantAvatar {
  group: THREE.Group;
  weaponAimPivot: THREE.Object3D;
  hitMeshes: THREE.Mesh[];
  update(
    elapsed: number,
    moveBlend: number,
    alive: boolean,
    recoil: number,
    hitFlash: number,
    aimPitch?: number,
  ): void;
}

export interface WeaponRig {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  flash: THREE.Object3D;
  update(
    elapsed: number,
    moveBlend: number,
    recoil: number,
    firing: boolean,
    crouchBlend: number,
    airborneBlend: number,
  ): void;
  setVisible(visible: boolean): void;
}

export interface HostageAvatar {
  group: THREE.Group;
  update(elapsed: number, moveBlend: number, escorted: boolean): void;
  setVisible(visible: boolean): void;
}

function makeMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 1,
    metalness: 0.04,
    flatShading: true,
    emissive: "#000000",
  });
}

export function createCombatantAvatar(accentColor: string): CombatantAvatar {
  const group = new THREE.Group();
  const bodyMaterial = makeMaterial("#6D6C66");
  const accentMaterial = makeMaterial(accentColor);
  const detailMaterial = makeMaterial("#2E3031");
  const skinMaterial = makeMaterial("#B69C79");

  const hitMaterials = [bodyMaterial, accentMaterial, detailMaterial, skinMaterial];

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1, 0.48), bodyMaterial);
  torso.position.y = 1.18;
  torso.castShadow = true;
  torso.receiveShadow = true;
  group.add(torso);

  const chestRig = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.22, 0.56), accentMaterial);
  chestRig.position.set(0, 1.22, 0.2);
  chestRig.castShadow = true;
  group.add(chestRig);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.52), skinMaterial);
  head.position.y = 1.95;
  head.castShadow = true;
  group.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.16), detailMaterial);
  visor.position.set(0, 1.97, 0.28);
  group.add(visor);

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.6, 1.5, 0);
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.6, 1.5, 0);
  group.add(rightArmPivot);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.22, 0.72, 0);
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.22, 0.72, 0);
  group.add(rightLegPivot);

  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.86, 0.24), bodyMaterial);
  leftArm.position.y = -0.44;
  leftArm.castShadow = true;
  leftArmPivot.add(leftArm);

  const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.86, 0.24), bodyMaterial);
  rightArm.position.y = -0.44;
  rightArm.castShadow = true;
  rightArmPivot.add(rightArm);

  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.95, 0.28), accentMaterial);
  leftLeg.position.y = -0.48;
  leftLeg.castShadow = true;
  leftLegPivot.add(leftLeg);

  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.95, 0.28), accentMaterial);
  rightLeg.position.y = -0.48;
  rightLeg.castShadow = true;
  rightLegPivot.add(rightLeg);

  const weaponAimPivot = new THREE.Group();
  weaponAimPivot.position.set(0.18, 1.36, 0.34);
  group.add(weaponAimPivot);

  const rifle = new THREE.Group();
  rifle.rotation.set(0, -Math.PI / 2, -0.12);
  weaponAimPivot.add(rifle);

  const rifleBody = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.18), detailMaterial);
  rifleBody.castShadow = true;
  rifle.add(rifleBody);

  const rifleStock = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.18), accentMaterial);
  rifleStock.position.x = -0.42;
  rifle.add(rifleStock);

  const rifleBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 0.08), detailMaterial);
  rifleBarrel.position.x = 0.48;
  rifle.add(rifleBarrel);

  const rifleGrip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.12), bodyMaterial);
  rifleGrip.position.set(-0.02, -0.2, 0);
  rifle.add(rifleGrip);

  const muzzleFlashMaterial = new THREE.MeshBasicMaterial({
    color: "#FFD18A",
    transparent: true,
    opacity: 0,
  });
  const muzzleFlash = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), muzzleFlashMaterial);
  muzzleFlash.position.x = 0.7;
  muzzleFlash.visible = false;
  rifle.add(muzzleFlash);

  const hitMeshes = [torso, chestRig, head, visor, leftArm, rightArm, leftLeg, rightLeg];

  return {
    group,
    weaponAimPivot,
    hitMeshes,
    update(elapsed, moveBlend, alive, recoil, hitFlash, aimPitch = 0) {
      const swing = Math.sin(elapsed * 7.6) * 0.75 * moveBlend;
      const pulse = Math.max(0, hitFlash);
      const clampedAimPitch = THREE.MathUtils.clamp(aimPitch, -1.05, 1.05);

      leftArmPivot.rotation.x = alive ? swing : -0.9;
      rightArmPivot.rotation.x = alive ? -swing - recoil * 0.7 : 0.28;
      leftLegPivot.rotation.x = alive ? -swing : 0;
      rightLegPivot.rotation.x = alive ? swing : 0;

      torso.rotation.z = alive ? Math.sin(elapsed * 3.2) * 0.035 * moveBlend : -0.18;
      weaponAimPivot.rotation.set(alive ? -clampedAimPitch : 0, 0, 0);
      rifle.rotation.z = alive ? -0.12 - recoil * 0.18 : -0.48;
      rifle.rotation.x = alive ? 0 : 0.22;
      group.rotation.x = 0;
      group.rotation.z = alive ? 0 : 1.34;
      group.position.y = alive ? 0 : 0.08;

      muzzleFlash.visible = alive && recoil > 0.34;
      muzzleFlashMaterial.opacity = muzzleFlash.visible ? Math.min(0.88, recoil) : 0;

      for (const material of hitMaterials) {
        material.emissive.setRGB(0.34 * pulse, 0.08 * pulse, 0.02 * pulse);
      }
    },
  };
}

export function createWeaponRig(): WeaponRig {
  const group = new THREE.Group();
  const bodyMaterial = makeMaterial("#6E705D");
  const detailMaterial = makeMaterial("#2C3030");
  const accentMaterial = makeMaterial("#8A6342");
  const flashMaterial = new THREE.MeshBasicMaterial({
    color: "#FFD89B",
    transparent: true,
    opacity: 0.92,
  });

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.58), bodyMaterial);
  receiver.position.set(0.02, 0.02, -0.08);
  group.add(receiver);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.24), accentMaterial);
  stock.position.set(0.04, 0.04, 0.32);
  group.add(stock);

  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.36), detailMaterial);
  handguard.position.set(0.02, 0.01, -0.5);
  group.add(handguard);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.12), detailMaterial);
  grip.position.set(0.02, -0.2, -0.02);
  group.add(grip);

  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.2), bodyMaterial);
  sight.position.set(0.02, 0.15, -0.22);
  group.add(sight);

  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.32), detailMaterial);
  barrel.position.set(0.02, 0.03, -0.82);
  group.add(barrel);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.02, 0.03, -1);
  group.add(muzzle);

  const flash = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), flashMaterial);
  flash.position.copy(muzzle.position);
  flash.visible = false;
  group.add(flash);

  return {
    group,
    muzzle,
    flash,
    update(elapsed, moveBlend, recoil, firing, crouchBlend, airborneBlend) {
      const bob = Math.sin(elapsed * 9.4) * 0.018 * moveBlend;
      const sway = Math.cos(elapsed * 4.2) * 0.01;
      const crouchDrop = 0.08 * crouchBlend;
      const airborneLift = 0.05 * airborneBlend;

      group.position.set(
        0.48 + sway,
        -0.48 + bob - recoil * 0.08 - crouchDrop + airborneLift,
        -0.72 + recoil * 0.14 + crouchBlend * 0.05,
      );
      group.rotation.set(
        0.04 + recoil * 0.08 - crouchBlend * 0.04 + airborneBlend * 0.06,
        0.13 + recoil * 0.02,
        -0.07 - recoil * 0.12 - crouchBlend * 0.02,
      );

      flash.visible = firing;
      flash.scale.setScalar(firing ? 1 + recoil * 1.5 : 1);
      flashMaterial.opacity = firing ? 0.9 : 0;
    },
    setVisible(visible) {
      group.visible = visible;
    },
  };
}

export function createHostageAvatar(): HostageAvatar {
  const group = new THREE.Group();
  const coatMaterial = makeMaterial("#6F675C");
  const accentMaterial = makeMaterial("#A38768");
  const detailMaterial = makeMaterial("#343637");
  const skinMaterial = makeMaterial("#C2A17E");

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.02, 0.44), coatMaterial);
  torso.position.y = 1.16;
  torso.castShadow = true;
  torso.receiveShadow = true;
  group.add(torso);

  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.5), accentMaterial);
  vest.position.set(0, 1.16, 0.02);
  vest.castShadow = true;
  group.add(vest);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), skinMaterial);
  head.position.y = 1.92;
  head.castShadow = true;
  group.add(head);

  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.16, 0.54), detailMaterial);
  cap.position.set(0, 2.18, 0);
  group.add(cap);

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.54, 1.48, 0);
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.54, 1.48, 0);
  group.add(rightArmPivot);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.2, 0.72, 0);
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.2, 0.72, 0);
  group.add(rightLegPivot);

  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.82, 0.22), coatMaterial);
  leftArm.position.y = -0.42;
  leftArm.castShadow = true;
  leftArmPivot.add(leftArm);

  const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.82, 0.22), coatMaterial);
  rightArm.position.y = -0.42;
  rightArm.castShadow = true;
  rightArmPivot.add(rightArm);

  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.92, 0.26), detailMaterial);
  leftLeg.position.y = -0.46;
  leftLeg.castShadow = true;
  leftLegPivot.add(leftLeg);

  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.92, 0.26), detailMaterial);
  rightLeg.position.y = -0.46;
  rightLeg.castShadow = true;
  rightLegPivot.add(rightLeg);

  return {
    group,
    update(elapsed, moveBlend, escorted) {
      const swing = Math.sin(elapsed * 6.4) * 0.55 * moveBlend;
      const shoulderSet = escorted ? 0.12 : -0.08;

      leftArmPivot.rotation.x = swing * 0.7 + shoulderSet;
      rightArmPivot.rotation.x = -swing * 0.7 + shoulderSet;
      leftLegPivot.rotation.x = -swing;
      rightLegPivot.rotation.x = swing;
      torso.rotation.z = Math.sin(elapsed * 2.6) * 0.03 * moveBlend;
      group.rotation.z = 0;
      group.position.y = 0;
    },
    setVisible(visible) {
      group.visible = visible;
    },
  };
}
