# Security Specification for Neon Arena 3D

## Data Invariants
1. A player document must be indexed by the user's UID.
2. `uid` field must match `request.auth.uid`.
3. `lastSeen` must be `request.time`.
4. `position` coordinates must be numbers within a reasonable range (e.g., -50 to 50 for arena bounds).
5. `rotationY` must be a number.
6. `color` must be a valid hex string of 7 characters (e.g., #FFFFFF).

## The Dirty Dozen Payloads (Target: /players/{uid})

1. **Identity Theft**: User A tries to create a player document with User B's UID in the fields.
2. **Shadow Field Injection**: User A adds `isAdmin: true` to their player document.
3. **Ghost Update**: User A tries to update User B's position.
4. **Time Spoofing**: User A sends a manual timestamp string for `lastSeen` instead of `serverTimestamp()`.
5. **Out of Bounds**: User A teleporting by setting `position.x: 99999`.
6. **Type Mismatch**: User A setting `position: "floating"`.
7. **Size Attack**: User A setting `name` to a 1MB string.
8. **ID Poisoning**: User A trying to create a document with an ID that contains malicious characters or is too long.
9. **Mutation Lockout**: User A trying to change their immutable `uid` after creation.
10. **Partial Corruption**: User A updating only `name` and deleting `position` property.
11. **Malicious Hex**: User A setting `color` to something like "RED_AND_MALICIOUS".
12. **Blanket Read Request**: An unauthenticated user tries to list all players.

## Test Runner (Draft Logic)
The `firestore.rules` should ensure all above payloads result in `PERMISSION_DENIED`.
