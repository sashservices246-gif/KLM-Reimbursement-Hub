// emulatorSetup.js

const admin = require('firebase-admin'); // Import the Firebase Admin SDK

// --- 1. Load your Service Account Key ---
// Ensure this path is correct relative to where you run the script
const serviceAccount = require('./serviceAccountKey.json');

// --- 2. Initialize the Firebase Admin SDK ---
// This is where the magic happens.
// The "credential" authenticates your script as an admin.
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // databaseURL: 'https://klm-reimbursement-hub.firebaseio.com' // Optional: Only needed if you use Realtime Database
});

console.log("Firebase Admin SDK initialized!");

// --- 3. Get references to Firebase services with admin privileges ---
const db = admin.firestore();
const auth = admin.auth();

// --- 4. Connect to Firebase Emulators (Crucial for testing!) ---
// You must set these environment variables *before* the script runs
// For Firestore: process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080"; // Your Firestore Emulator address
// For Auth: process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";   // Your Auth Emulator address

// The Admin SDK automatically detects these environment variables and connects to the emulators.
// No explicit 'connectFirestoreEmulator' or 'connectAuthEmulator' calls are needed for the Admin SDK.

console.log(`Firestore Emulator Host: ${process.env.FIRESTORE_EMULATOR_HOST || 'Not set (will use production)'}`);
console.log(`Auth Emulator Host: ${process.env.FIREBASE_AUTH_EMULATOR_HOST || 'Not set (will use production)'}`);


// --- Now you can use `db` and `auth` to interact with your emulators ---
// Example: Create a test user or set up a roles document
async function setupEmulatorData() {
    try {
        // Example: Create an admin user for testing
        const testAdminUid = "adminTestUser123";
        await auth.createUser({
            uid: testAdminUid,
            email: "admin@example.com",
            password: "password123"
        });
        console.log(`Created test admin user: ${testAdminUid}`);

        // Example: Set roles for this admin user directly in Firestore (bypassing security rules initially)
        const emulatorAppId = "emulator-app-id"; // Match this to what your client uses for emulators
        await db.collection("artifacts").doc(emulatorAppId)
                  .collection("public").doc("data")
                  .collection("roles").doc(testAdminUid)
                  .set({
                      isAdmin: true,
                      isSupervisor: true
                  });
        console.log(`Set roles for ${testAdminUid} in Firestore.`);

        // Example: Clean up (optional - usually you'd keep test data)
        // await auth.deleteUser(testAdminUid);
        // console.log(`Deleted test admin user: ${testAdminUid}`);

    } catch (error) {
        console.error("Error setting up emulator data:", error.message);
    } finally {
        // Optional: Exit the process if this is a one-off script
        // process.exit();
    }
}

// Export `db` and `auth` for use in other test files if you have a larger test suite
module.exports = { db, auth, setupEmulatorData };

// If this script is run directly, execute the setup function
// (This part is often commented out if you're using a test runner like Mocha/Jest)
if (require.main === module) {
  // It's good practice to ensure emulators are running before this script
  console.log("Running emulator setup script...");
  setupEmulatorData();
}
