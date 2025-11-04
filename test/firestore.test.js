// test/firestore.test.js

// Import the rules unit testing library
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} = require("@firebase/rules-unit-testing");

// Import the Firebase Admin SDK
const admin = require('firebase-admin');

// Import 'path' module for robust path resolution
const path = require('path');

// --- Your Service Account Key ---
// IMPORTANT: Ensure 'serviceAccountKey.json' is in the same directory as this script,
// or provide the correct relative path.
// This is used by the Admin SDK for privileged operations in the emulator.
const serviceAccount = require('../serviceAccountKey.json');

// --- RulesTestEnvironment instance ---
// This will be initialized once for all tests.
let testEnv;

// --- Initialize Admin SDK for privileged operations ---
// This is used to bypass security rules to set up initial data in the emulator.
// The Admin SDK automatically connects to emulators if FIRESTORE_EMULATOR_HOST
// and FIREBASE_AUTH_EMULATOR_HOST environment variables are set.
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // databaseURL: 'https://<YOUR_PROJECT_ID>.firebaseio.com' // Only needed for Realtime DB
});

// Get a Firestore client with admin privileges
const adminDb = admin.firestore();


// --- Before all tests ---
before(async () => {
  // Initialize the RulesTestEnvironment
  testEnv = await initializeTestEnvironment({
    projectId: "klm-reimbursement-hub", // Your Firebase Project ID
    firestore: {
      rules: require("fs").readFileSync(path.resolve(__dirname, '..', 'firestore.rules'), "utf8"), // Path to your rules file
    },
  });

  // Clear any data from previous test runs to ensure a clean slate
  await testEnv.clearFirestore(); // Keep this for overall cleanup

  console.log("\n--- Emulator environment initialized for rules testing ---");
});

// --- After all tests ---
after(async () => {
  // Clean up the test environment after all tests are done
  await testEnv.cleanup();
  console.log("\n--- Emulator environment cleaned up ---");
});

// --- Generic beforeEach (for all tests) ---
// This ensures *each individual test* in any describe block starts with a fresh Firestore.
beforeEach(async () => {
  await testEnv.clearFirestore();
  // We don't need to put common roles documents here globally,
  // as each specific describe block or test will handle its own setup.
});


// --- Your Test Suites Start Here ---

describe("Generic Security Rules - Sanity Checks", () => {
  // A very basic placeholder test
  it("should deny reads to non-existent paths (sanity check)", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    const docRef = unauthedDb.collection("nonExistentCollection").doc("someDoc");
    await assertFails(docRef.get());
  });
  it("should deny unauthenticated users from writing to any path (sanity check)", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    const docRef = unauthedDb.collection("someCollection").doc("someDoc");
    await assertFails(docRef.set({ someField: "value" }));
  });  
});


describe("Reports Collection Rules", () => {
  const EMULATOR_APP_ID = "emulator-app-id"; // Defined once for this suite
  const REPORT_PATH_BASE = `artifacts/${EMULATOR_APP_ID}/public/data/reports`;
  const ROLES_PATH_BASE = `artifacts/${EMULATOR_APP_ID}/public/data/roles`;

  // --- beforeEach for Reports Collection Rules ---
  // This will run BEFORE EACH TEST in this describe block,
  // ensuring necessary roles documents exist for tests that need them.
  beforeEach(async () => {
    // Ensure the adminTestUser123 roles document exists AFTER testEnv.clearFirestore()
    await adminDb.doc(`${ROLES_PATH_BASE}/adminTestUser123`).set({
      isAdmin: true,
      isSupervisor: true
    });
    // Create a supervisor-only user for testing
    await adminDb.doc(`${ROLES_PATH_BASE}/supervisorOnlyUser`).set({
      isAdmin: false, // Crucially, set to false
      isSupervisor: true
    });
    console.log(`  (Admin SDK) Re-created roles for adminTestUser123 and supervisorOnlyUser before test.`);
  });

  // Test 1: Unauthenticated users cannot read reports
  it("should deny unauthenticated users from reading any report", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    const reportDocRef = unauthedDb.collection(REPORT_PATH_BASE).doc("anyReportId");
    await assertFails(reportDocRef.get());
  });

  // Test 2: Anonymous authenticated user can read their own report
  it("should allow an anonymous authenticated user to read their own report", async () => {
    const anonymousUserId = "anonUser123";
    const reportId = "KLM-AnonTestReport1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: anonymousUserId,
      amount: 50,
      description: "Anonymous test report",
    });
    console.log(`  (Admin SDK) Created report ${reportId} for user ${anonymousUserId}`);

    const anonUserDb = testEnv.authenticatedContext(anonymousUserId).firestore();
    const reportDocRef = anonUserDb.doc(REPORT_FULL_PATH);

    await assertSucceeds(reportDocRef.get());
    console.log(`  (Test Client) Anonymous user ${anonymousUserId} successfully read their own report.`);
  });

  // Test 3: Supervisor can read any report (not just their own)
  it("should allow a supervisor to read any report", async () => {
    const supervisorUid = "adminTestUser123"; // Our pre-existing admin/supervisor user
    const otherUserUid = "otherUser456";
    const reportIdForOtherUser = "KLM-OtherUserReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportIdForOtherUser}`;

    // Create a report submitted by 'otherUser456'
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 200,
      description: "Report by another user for supervisor to read",
    });
    console.log(`  (Admin SDK) Created report ${reportIdForOtherUser} for user ${otherUserUid}`);

    // Create an authenticated Firestore client for the supervisor
    const supervisorDb = testEnv.authenticatedContext(supervisorUid, { isSupervisor: true, isAdmin: true }).firestore();

    const reportDocRef = supervisorDb.doc(REPORT_FULL_PATH);

    await assertSucceeds(reportDocRef.get());
    console.log(`  (Test Client) Supervisor ${supervisorUid} successfully read ${reportIdForOtherUser}.`);
  });

  // Test 4: Deny a regular (non-admin/non-supervisor) user from reading another user's report
  it("should deny a regular user from reading another user's report", async () => {
    const regularUserUid = "regularUser789";
    const otherUserUid = "otherUser101"; // User who submitted the report
    const reportIdForOtherUser = "KLM-OtherUserReportDenied";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportIdForOtherUser}`;

    // Use Admin SDK to create a report submitted by 'otherUser101'
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 300,
      description: "Report by another user to be denied",
    });
    console.log(`  (Admin SDK) Created report ${reportIdForOtherUser} for user ${otherUserUid}`);

    // Create an authenticated Firestore client for the regular user
    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore(); // No special claims

    const reportDocRef = regularUserDb.doc(REPORT_FULL_PATH);

    // Assert that the read operation fails
    await assertFails(reportDocRef.get());
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied reading ${reportIdForOtherUser}.`);
  });

  // Test 5: Supervisor can approve another user's report
  it("should allow a supervisor to approve another user's report", async () => {
    const supervisorUid = "adminTestUser123"; // Our pre-existing admin/supervisor user
    const claimantUid = "otherUser456";
    const reportId = "KLM-SupervisorApprovesOther";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create a report submitted by 'otherUser456' using adminDb
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: claimantUid,
      amount: 150,
      description: "Report for supervisor approval",
      authorization: { // Ensure authorization fields exist, even if empty initially
        claimantSignature: "Claimant Sign",
        claimantAuthDate: "2025-10-18",
        approverSignature: "",
        approverAuthDate: ""
      }
    });
    console.log(`  (Admin SDK) Created report ${reportId} for user ${claimantUid}`);

    // Create an authenticated Firestore client for the supervisor
    const supervisorDb = testEnv.authenticatedContext(supervisorUid, { isSupervisor: true, isAdmin: true }).firestore();

    // Attempt to update the report with an approval signature
    const reportRef = supervisorDb.doc(REPORT_FULL_PATH);
    await assertSucceeds(reportRef.update({
      "authorization.approverSignature": "Supervisor Approval",
      "authorization.approverAuthDate": "2025-10-18"
    }));
    console.log(`  (Test Client) Supervisor ${supervisorUid} successfully approved ${reportId}.`);
  });

  // Test 6: Supervisor CANNOT approve their own report
  it("should deny a supervisor from approving their own report", async () => {
    const supervisorUid = "adminTestUser123"; // Our pre-existing admin/supervisor user, who is also the claimant
    const reportId = "KLM-SupervisorApprovesOwn";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create a report submitted by the supervisor themselves using adminDb
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: supervisorUid,
      amount: 250,
      description: "Supervisor's own report for approval",
      authorization: { // Ensure authorization fields exist, even if empty initially
        claimantSignature: "Supervisor Sign",
        claimantAuthDate: "2025-10-18",
        approverSignature: "",
        approverAuthDate: ""
      }
    });
    console.log(`  (Admin SDK) Created report ${reportId} submitted by ${supervisorUid}`);

    // Create an authenticated Firestore client for the supervisor
    const supervisorDb = testEnv.authenticatedContext(supervisorUid, { isSupervisor: true, isAdmin: true }).firestore();

    // Attempt to update the report with an approval signature - this should FAIL
    const reportRef = supervisorDb.doc(REPORT_FULL_PATH);
    await assertFails(reportRef.update({
      "authorization.approverSignature": "Supervisor Approves Own",
      "authorization.approverAuthDate": "2025-10-18"
    }));
    console.log(`  (Test Client) Supervisor ${supervisorUid} correctly denied approving their own report ${reportId}.`);
  });

  // Test 7: Admin can delete any report
  it("should allow an admin to delete any report", async () => {
    const adminUid = "adminTestUser123"; // Our pre-existing admin user
    const otherUserUid = "deleteTargetUser";
    const reportIdToDelete = "KLM-AdminDeleteTarget";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportIdToDelete}`;

    // Create a report submitted by 'deleteTargetUser' using adminDb
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 999,
      description: "Report to be deleted by admin",
    });
    console.log(`  (Admin SDK) Created report ${reportIdToDelete} for user ${otherUserUid}`);

    // Create an authenticated Firestore client for the admin
    const adminDbClient = testEnv.authenticatedContext(adminUid, { isAdmin: true }).firestore();

    // Assert that the delete operation succeeds
    const reportRef = adminDbClient.doc(REPORT_FULL_PATH);
    await assertSucceeds(reportRef.delete());
    console.log(`  (Test Client) Admin ${adminUid} successfully deleted ${reportIdToDelete}.`);
  });

  // Test 8: Regular user cannot delete any report
  it("should deny a regular user from deleting any report", async () => {
    const regularUserUid = "regularUserDeleteAttempt";
    const otherUserUid = "deleteProtectedUser";
    const reportIdToProtect = "KLM-RegularUserDeleteAttempt"; // Use a unique ID
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportIdToProtect}`;

    // Create a report submitted by 'otherUser101'
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 123,
      description: "Report to be protected from regular user deletion",
    });
    console.log(`  (Admin SDK) Created report ${reportIdToProtect} for user ${otherUserUid}`);

    // Create an authenticated Firestore client for a regular user (no special claims needed)
    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();

    // Assert that the regular user's delete operation fails
    const regularUserReportRef = regularUserDb.doc(REPORT_FULL_PATH);
    await assertFails(regularUserReportRef.delete());
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied deleting ${reportIdToProtect}.`);
  });

  // Test 9: Supervisor (who is not an admin) cannot delete any report
  it("should deny a supervisor (non-admin) from deleting any report", async () => {
    const supervisorOnlyUid = "supervisorOnlyUser"; // This user has isAdmin: false in Firestore roles doc
    const otherUserUid = "deleteProtectedUser2";
    const reportIdToProtect = "KLM-SupervisorOnlyDeleteAttempt"; // Use a unique ID
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportIdToProtect}`;

    // Create a report submitted by 'otherUser'
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 456,
      description: "Report to be protected from supervisor-only deletion",
    });
    console.log(`  (Admin SDK) Created report ${reportIdToProtect} for user ${otherUserUid}`);

    // Create an authenticated Firestore client for the supervisor-only user
    // We pass { isSupervisor: true } in claims, but isAdmin: false is from Firestore document
    const supervisorOnlyDbClient = testEnv.authenticatedContext(supervisorOnlyUid, { isSupervisor: true }).firestore();

    // Assert that the supervisor's delete operation also fails
    const supervisorReportRef = supervisorOnlyDbClient.doc(REPORT_FULL_PATH);
    await assertFails(supervisorReportRef.delete());
    console.log(`  (Test Client) Supervisor ${supervisorOnlyUid} correctly denied deleting ${reportIdToProtect}.`);
  });

  // Test 10: Authenticated user can create their own report (submittedByUserId matches uid)
  it("should allow an authenticated user to create their own report", async () => {
    const userUid = "creatorUser1";
    const reportId = "KLM-CreatorOwnReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create an authenticated Firestore client for the user
    const userDb = testEnv.authenticatedContext(userUid).firestore();

    // Attempt to create a report where submittedByUserId matches userUid
    await assertSucceeds(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 100,
      description: "Report created by own user",
    }));
    console.log(`  (Test Client) User ${userUid} successfully created their own report ${reportId}.`);
  });

  // Test 11: Authenticated user cannot create a report for another user (submittedByUserId does not match uid)
  it("should deny an authenticated user from creating a report for another user", async () => {
    const currentUserUid = "attemptingCreator1";
    const targetUserUid = "anotherUser2"; // The user whose ID is in submittedByUserId
    const reportId = "KLM-OtherUserReportAttempt";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create an authenticated Firestore client for the current user
    const currentUserDb = testEnv.authenticatedContext(currentUserUid).firestore();

    // Attempt to create a report where submittedByUserId is for another user
    await assertFails(currentUserDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: targetUserUid, // This is the mismatch
      amount: 200,
      description: "Report attempting to be created for another user",
    }));
    console.log(`  (Test Client) User ${currentUserUid} correctly denied creating report ${reportId} for ${targetUserUid}.`);
  });
  //Test 12: Authenticated user cannot update a report for another user (Non-Supervisor/NonAdmin)
  it("should deny a regular user from updating another user's report", async () => {
    const regularUserUid = "regularUpdaterDenied";
    const otherUserUid = "otherUserForUpdateAttempt";
    const reportId = "KLM-RegularUserUpdateOther";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 100,
      description: "Report for update attempt",
    });
    console.log(`  (Admin SDK) Created report ${reportId} for user ${otherUserUid}`);

    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();
    const reportDocRef = regularUserDb.doc(REPORT_FULL_PATH);

    await assertFails(reportDocRef.update({ amount: 150 }));
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied updating report ${reportId} by ${otherUserUid}.`);
  });
  //Test 13: Supervisor can create a report (if submittedByUserId matches)
    it("should allow a supervisor to create their own report", async () => {
    const supervisorUid = "adminTestUser123"; // Our pre-existing supervisor user
    const reportId = "KLM-SupervisorCreatesOwn";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const supervisorDb = testEnv.authenticatedContext(supervisorUid, { isSupervisor: true, isAdmin: true }).firestore();

    await assertSucceeds(supervisorDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: supervisorUid,
      amount: 500,
      description: "Supervisor's own created report",
    }));
    console.log(`  (Test Client) Supervisor ${supervisorUid} successfully created their own report ${reportId}.`);
  });
  // Test 14: Admin/Supervisor can create a report for another user via proxy submission
  it("should allow an Admin/Supervisor to create a report for another user via proxy submission", async () => {
    const adminSupervisorUid = "adminTestUser123"; // Has isAdmin and isSupervisor roles
    const targetUserUid = "nonAdminClaimant1"; // The user the report is for
    const reportId = "KLM-AdminProxyReport1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Ensure targetUserUid has a roles document if your rules or functions expect it,
    // though not strictly necessary for this specific 'create' rule.
    await adminDb.doc(`${ROLES_PATH_BASE}/${targetUserUid}`).set({
      isAdmin: false,
      isSupervisor: false
    });

    const adminSupervisorDb = testEnv.authenticatedContext(adminSupervisorUid, {
      isAdmin: true,
      isSupervisor: true
    }).firestore();

    await assertSucceeds(adminSupervisorDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: targetUserUid,
      proxySubmitterId: adminSupervisorUid, // Admin identifies themselves as proxy
      amount: 75,
      description: "Report created by Admin for another user",
    }));
    console.log(`  (Test Client) Admin/Supervisor ${adminSupervisorUid} successfully created report ${reportId} for ${targetUserUid} via proxy.`);
  });

  // Test 15: Admin/Supervisor cannot create a report for themselves using the proxy mechanism
  it("should deny an Admin/Supervisor from creating a report for themselves using the proxy mechanism", async () => {
    const adminSupervisorUid = "adminTestUser123"; // Has isAdmin and isSupervisor roles
    const reportId = "KLM-AdminProxySelfReportDenied";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const adminSupervisorDb = testEnv.authenticatedContext(adminSupervisorUid, {
      isAdmin: true,
      isSupervisor: true
    }).firestore();

    // Attempt to create a report where submittedByUserId IS the same as proxySubmitterId
    // This should be denied by `request.resource.data.submittedByUserId != request.auth.uid` part of the proxy rule
    await assertFails(adminSupervisorDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: adminSupervisorUid, // Submitted for themselves
      proxySubmitterId: adminSupervisorUid, // Attempting proxy for themselves
      amount: 100,
      description: "Admin/Supervisor trying to proxy their own report (should fail)",
    }));
    console.log(`  (Test Client) Admin/Supervisor ${adminSupervisorUid} correctly denied creating report ${reportId} for themselves via proxy.`);
  });

  // Test 16: Regular user cannot create a report for another user (impersonation attempt)
  it("should deny a regular user from creating a report for another user", async () => {
    const regularUserUid = "regularUserNoProxy";
    const targetUserUid = "impersonatedUser";
    const reportId = "KLM-RegularUserImpersonationDenied";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Ensure regularUserUid has a roles document
    await adminDb.doc(`${ROLES_PATH_BASE}/${regularUserUid}`).set({
      isAdmin: false,
      isSupervisor: false
    });

    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();

    // Attempt to create a report for 'impersonatedUser' by a 'regularUser'
    // This should fail because regularUser is not admin/supervisor
    await assertFails(regularUserDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: targetUserUid, // Attempting to create for another
      proxySubmitterId: regularUserUid, // Even if they identify as proxy, they lack roles
      amount: 200,
      description: "Regular user trying to create report for another (should fail)",
    }));
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied creating report ${reportId} for ${targetUserUid}.`);
  });
  // Test 17: Regular user can update their own report's non-approval fields (isApprovalAction() should be false)
  it("should allow a regular user to update their own report's non-approval fields", async () => {
    const regularUserUid = "regularUserForUpdate";
    const reportId = "KLM-RegularUserUpdateNonApproval";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create report and initial roles document for regularUser
    await adminDb.doc(`${ROLES_PATH_BASE}/${regularUserUid}`).set({ isAdmin: false, isSupervisor: false });
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: regularUserUid,
      amount: 100,
      description: "Original description",
      authorization: { approverSignature: '', approverAuthDate: '', claimantSignature: '', claimantAuthDate: '' } // Initially empty
    });
    console.log(`  (Admin SDK) Created report ${reportId} for user ${regularUserUid}`);

    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();

    // Attempt to update a non-approval field
    await assertSucceeds(regularUserDb.doc(REPORT_FULL_PATH).update({
      amount: 150,
      description: "Updated description"
    }));
    console.log(`  (Test Client) Regular user ${regularUserUid} successfully updated non-approval fields of their report.`);
  });

  // Test 18: Admin/Supervisor can update non-approval fields of another user's approved report (isApprovalAction() should be false)
  it("should allow Admin/Supervisor to update non-approval fields of another user's approved report", async () => {
    const adminSupervisorUid = "adminTestUser123";
    const otherUserUid = "otherUserApprovedReport";
    const reportId = "KLM-AdminUpdateApprovedNonApproval";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`; // This implicitly uses EMULATOR_APP_ID

    // We need to explicitly define the full path to the role document that the rules will look for.
    const ROLE_DOC_PATH_FOR_RULES = `${ROLES_PATH_BASE}/${adminSupervisorUid}`; // This also uses EMULATOR_APP_ID

    // Create report with fully approved status (Case 3)
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 200,
      description: "Approved report description",
      authorization: { 
        approverSignature: 'Existing Signature',          // Already approved
        approverAuthDate: '2023-01-01',                   // Must be a valid date string if signature is present
        claimantSignature: 'Existing Claimant Signature', // Can be empty string
        claimantAuthDate: '2023-01-01'                    // Can be empty string
       } 
    });
    console.log(`  (Admin SDK) Created fully approved report ${reportId} for user ${otherUserUid}`);

    const adminSupervisorDb = testEnv.authenticatedContext(adminSupervisorUid, {
      isAdmin: true,
      isSupervisor: true
    }).firestore();

    
    // Attempt to update a non-approval field
    await assertSucceeds(adminSupervisorDb.doc(REPORT_FULL_PATH).update({
      amount: 250,
      description: "Admin/Supervisor updated description post-approval"
    }));
    console.log(`  (Test Client) Admin/Supervisor ${adminSupervisorUid} successfully updated non-approval fields of other user's approved report.`);
  });

  // Test 19: Admin/Supervisor can change an existing approverSignature (not an initial approval, so isApprovalAction() should be false)
  it("should allow Admin/Supervisor to change an existing approverSignature", async () => {
    const adminSupervisorUid = "adminTestUser123";
    const otherUserUid = "otherUserSignedReport";
    const reportId = "KLM-AdminChangeExistingSignature";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create report with an existing approval signature
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 300,
      description: "Report with existing signature",
      authorization: { 
        approverSignature: 'Old Signature', 
        approverAuthDate: '2023-01-01', 
        claimantSignature: 'Claimant Signature', 
        claimantAuthDate: '2023-01-01' 
      }
    });
    console.log(`  (Admin SDK) Created report ${reportId} with old signature for user ${otherUserUid}`);

    const adminSupervisorDb = testEnv.authenticatedContext(adminSupervisorUid, {
      isAdmin: true,
      isSupervisor: true
    }).firestore();

    // Attempt to change the approverSignature
    await assertSucceeds(adminSupervisorDb.doc(REPORT_FULL_PATH).update({
      "authorization.approverSignature": "New Signature"
    }));
    console.log(`  (Test Client) Admin/Supervisor ${adminSupervisorUid} successfully changed existing approverSignature.`);
  });

  // Test 20: Admin/Supervisor can clear an approverSignature (not an initial approval, so isApprovalAction() should be false)
  it("should allow Admin/Supervisor to clear an approverSignature", async () => {
    const adminSupervisorUid = "adminTestUser123";
    const otherUserUid = "otherUserToClearSignature";
    const reportId = "KLM-AdminClearSignature";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create report with an existing approval signature
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 350,
      description: "Report with existing signature to clear",
      authorization: { approverSignature: 'Signature To Be Cleared', approverAuthDate: '', claimantSignature: '', claimantAuthDate: '' }
    });
    console.log(`  (Admin SDK) Created report ${reportId} with signature to clear for user ${otherUserUid}`);

    const adminSupervisorDb = testEnv.authenticatedContext(adminSupervisorUid, {
      isAdmin: true,
      isSupervisor: true
    }).firestore();

    // Attempt to clear the approverSignature
    await assertSucceeds(adminSupervisorDb.doc(REPORT_FULL_PATH).update({
      "authorization.approverSignature": ""
    }));
    console.log(`  (Test Client) Admin/Supervisor ${adminSupervisorUid} successfully cleared approverSignature.`);
  });

  // Test 21: Authenticated user without a roles document should be treated as a regular user (can read their own report)
  it("should allow an authenticated user without a roles document to read their own report", async () => {
    const userWithoutRolesUid = "userWithoutRoles1";
    const reportId = "KLM-UserWithoutRolesOwnReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // IMPORTANT: DO NOT create a roles document for userWithoutRolesUid
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userWithoutRolesUid,
      amount: 50,
      description: "Report by user without roles document",
      authorization: { approverSignature: '' }
    });
    console.log(`  (Admin SDK) Created report ${reportId} for user ${userWithoutRolesUid}`);

    const userDb = testEnv.authenticatedContext(userWithoutRolesUid).firestore();
    const reportDocRef = userDb.doc(REPORT_FULL_PATH);

    // This should succeed as `request.auth.uid == resource.data.submittedByUserId` will be true
    await assertSucceeds(reportDocRef.get());
    console.log(`  (Test Client) User ${userWithoutRolesUid} (no roles doc) successfully read their own report.`);
  });


  // Test 22: Authenticated user without a roles document should be treated as a regular user (cannot read another's report)
  it("should deny an authenticated user without a roles document from reading another user's report", async () => {
    const userWithoutRolesUid = "userWithoutRoles2";
    const otherUserUid = "someOtherClaimant3";
    const reportId = "KLM-UserWithoutRolesOtherReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // IMPORTANT: DO NOT create a roles document for userWithoutRolesUid
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: otherUserUid,
      amount: 75,
      description: "Report by another user, inaccessible to user without roles doc",
      authorization: { approverSignature: '' }
    });
    console.log(`  (Admin SDK) Created report ${reportId} for user ${otherUserUid}`);

    const userDb = testEnv.authenticatedContext(userWithoutRolesUid).firestore();
    const reportDocRef = userDb.doc(REPORT_FULL_PATH);

    // This should fail because isSupervisor(appId) and isAdmin(appId) will be false
    // and request.auth.uid != resource.data.submittedByUserId
    await assertFails(reportDocRef.get());
    console.log(`  (Test Client) User ${userWithoutRolesUid} (no roles doc) correctly denied reading ${otherUserUid}'s report.`);
  });
  // Test 23: Deny report creation with invalid amount (not a number) - UNCHANGED
  it("should deny report creation if amount is not a number", async () => {
    const userUid = "invalidAmountUser1";
    const reportId = "KLM-InvalidAmountReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: "not-a-number", // Invalid amount
      description: "Valid description",
      authorization: { approverSignature: '' }
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with non-numeric amount.`);
  });

  // Test 24: Allow report creation with a negative amount (NEW EXPECTATION)
  it("should allow report creation if amount is a negative number", async () => {
    const userUid = "negativeAmountUser1";
    const reportId = "KLM-NegativeAmountReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertSucceeds(userDb.doc(REPORT_FULL_PATH).set({ // Changed to assertSucceeds
      submittedByUserId: userUid,
      amount: -10, // Valid negative amount
      description: "Valid description for negative amount",
      authorization: { approverSignature: '', approverAuthDate: '', claimantSignature: '', claimantAuthDate: '' }
    }));
    console.log(`  (Test Client) User ${userUid} successfully created report with negative amount.`);
  });

  // Test 25: Deny report creation with empty description - UNCHANGED
  it("should deny report creation if description is empty", async () => {
    const userUid = "emptyDescUser1";
    const reportId = "KLM-EmptyDescReport";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 50,
      description: "", // Empty description
      authorization: { approverSignature: '' }
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with empty description.`);
  });

  // Test 26: Deny report update with invalid amount (not a number) - UNCHANGED
  it("should deny report update if amount is changed to a non-number", async () => {
    const userUid = "updateInvalidAmountUser";
    const reportId = "KLM-UpdateInvalidAmount";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create a valid report first
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 100,
      description: "Original valid description",
      authorization: { approverSignature: '' }
    });

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).update({
      amount: "new-invalid-amount" // Invalid update
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied updating report with non-numeric amount.`);
  });

  // Test 27: Deny report update with empty description - UNCHANGED
  it("should deny report update if description is changed to empty", async () => {
    const userUid = "updateEmptyDescUser";
    const reportId = "KLM-UpdateEmptyDesc";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create a valid report first
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 100,
      description: "Original valid description",
      authorization: { approverSignature: '' }
    });

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).update({
      description: "" // Invalid update
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied updating report with empty description.`);
  });
  // Test 28: Deny report creation if approverSignature is present but approverAuthDate is empty
  it("should deny report creation if approverSignature is present but approverAuthDate is empty", async () => {
    const userUid = "invalidAuthCreateUser1";
    const reportId = "KLM-InvalidAuthCreate1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 10,
      description: "Test report",
      authorization: { approverSignature: 'Signed', approverAuthDate: '' } // Invalid auth
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with incomplete approval data.`);
  });

  // Test 29: Deny report creation if approverAuthDate is present but approverSignature is empty
  it("should deny report creation if approverAuthDate is present but approverSignature is empty", async () => {
    const userUid = "invalidAuthCreateUser2";
    const reportId = "KLM-InvalidAuthCreate2";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 20,
      description: "Test report",
      authorization: { approverSignature: '', approverAuthDate: '2025-11-01' } // Invalid auth
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with incomplete approval data (date without signature).`);
  });

  // Test 30: Deny report creation if approverAuthDate is not a valid YYYY-MM-DD format
  it("should deny report creation if approverAuthDate has invalid format", async () => {
    const userUid = "invalidAuthCreateUser3";
    const reportId = "KLM-InvalidAuthCreate3";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 30,
      description: "Test report",
      authorization: { approverSignature: 'Signed', approverAuthDate: 'Invalid Date Format' } // Invalid date format
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with invalid approval date format.`);
  });

  // Test 31: Deny report update if approverSignature is updated without a valid approverAuthDate
  it("should deny report update if approverSignature is set without a valid approverAuthDate", async () => {
    const userUid = "updateInvalidAuthUser1";
    const reportId = "KLM-InvalidAuthUpdate1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create initial valid report
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 100,
      description: "Original description",
      authorization: { approverSignature: '', approverAuthDate: '' }
    });

    // We'll use an admin to simulate an invalid update that a regular user (or even admin) couldn't do
    // This tests the rule's data validation part, not just user permissions
    await assertFails(testEnv.authenticatedContext(userUid, { isAdmin: true, isSupervisor: true }).firestore().doc(REPORT_FULL_PATH).update({
      "authorization.approverSignature": "Admin Sign",
      "authorization.approverAuthDate": "" // Invalid: signature without date
    }));
    console.log(`  (Test Client) Admin correctly denied updating report with signature but no date.`);
  });

  // Test 32: Deny report update if approverAuthDate is updated with invalid format (while signature is present)
  it("should deny report update if approverAuthDate has invalid format (while signature is present)", async () => {
    const userUid = "updateInvalidAuthUser2";
    const reportId = "KLM-InvalidAuthUpdate2";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create initial valid report (already approved)
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 100,
      description: "Original description",
      authorization: { approverSignature: 'Original Sign', approverAuthDate: '2023-01-01' }
    });

    // Attempt to update date to invalid format
    await assertFails(testEnv.authenticatedContext(userUid, { isAdmin: true, isSupervisor: true }).firestore().doc(REPORT_FULL_PATH).update({
      "authorization.approverAuthDate": "Bad Date" // Invalid format
    }));
    console.log(`  (Test Client) Admin correctly denied updating report with invalid date format.`);
  });

  // Test 33: Allow report creation with valid authorization data (both empty)
  it("should allow report creation with empty authorization data", async () => {
    const userUid = "validAuthCreateUser1";
    const reportId = "KLM-ValidAuthCreate1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertSucceeds(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 40,
      description: "Valid initial report",
      authorization: { approverSignature: '', approverAuthDate: '', claimantSignature: '', claimantAuthDate: '' }
    }));
    console.log(`  (Test Client) User ${userUid} successfully created report with empty authorization data.`);
  });

  // Test 34: Allow report update to valid authorization data (clear approval)
  it("should allow report update to clear authorization data", async () => {
    const userUid = "validAuthUpdateUser1";
    const reportId = "KLM-ValidAuthUpdate1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    // Create a FULLY APPROVED report with all four fields populated and valid
    await adminDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 100,
      description: "Approved report to be unapproved",
      authorization: { approverSignature: 'SignedByApprover', approverAuthDate: '2024-01-01', claimantSignature: 'SignedbyClaimant', claimantAuthDate: '2024-01-01' }
    });

    // Authenticate Admin/Supervisor (assuming 'userUid' also has admin/supervisor roles for simplicity here,
    // or use 'adminTestUser123' if that's your designated admin)
    const adminOrSupervisorDb = testEnv.authenticatedContext(userUid, { isAdmin: true, isSupervisor: true }).firestore();    

  // Admin clears ONLY THE APPROVER'S authorization data
  // This transitions the report from Case 3 (Fully Approved) to Case 2 (Claimant Signed, Awaiting Approval)
  await assertSucceeds(adminOrSupervisorDb.doc(REPORT_FULL_PATH).update({
    "authorization.approverSignature": "", // Clear approver signature
    "authorization.approverAuthDate": ""   // Clear approver date
    // Claimant fields are intentionally NOT cleared, remaining as they were.
  }));
  console.log(`  (Test Client) Admin successfully cleared approver authorization data, retaining claimant's.`);

  // OPTIONAL: You might add a read to verify the state, though assertSucceeds implies it's valid.
  // const updatedReport = (await adminOrSupervisorDb.doc(REPORT_FULL_PATH).get()).data();
  // expect(updatedReport.authorization.approverSignature).to.equal('');
  // expect(updatedReport.authorization.approverAuthDate).to.equal('');
  // expect(updatedReport.authorization.claimantSignature).to.equal('SignedByClaimant');
  // expect(updatedReport.authorization.claimantAuthDate).to.equal('2024-01-01');
  });

  // Test 35: Deny report creation if claimantSignature is present but claimantAuthDate is empty
  it("should deny report creation if claimantSignature is present but claimantAuthDate is empty", async () => {
    const userUid = "invalidClaimantAuthCreate1";
    const reportId = "KLM-InvalidClaimantAuthCreate1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 10,
      description: "Test report",
      authorization: {
        approverSignature: '', approverAuthDate: '',
        claimantSignature: 'Claimed', claimantAuthDate: '' // Invalid claimant auth
      }
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with incomplete claimant data.`);
  });

  // Test 36: Deny report creation if claimantAuthDate has invalid format
  it("should deny report creation if claimantAuthDate has invalid format", async () => {
    const userUid = "invalidClaimantAuthCreate2";
    const reportId = "KLM-InvalidClaimantAuthCreate2";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 20,
      description: "Test report",
      authorization: {
        approverSignature: '', approverAuthDate: '',
        claimantSignature: 'Claimed', claimantAuthDate: 'Invalid Date' // Invalid claimant date format
      }
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with invalid claimant date format.`);
  });

  // Test 37: Allow report creation with valid (non-empty) claimant authorization data
  it("should allow report creation with valid claimant authorization data", async () => {
    const userUid = "validClaimantAuthCreate";
    const reportId = "KLM-ValidClaimantAuthCreate";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertSucceeds(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 30,
      description: "Test report with claimant signature",
      authorization: {
        approverSignature: '', approverAuthDate: '',
        claimantSignature: 'User Sign', claimantAuthDate: '2023-10-21' // Valid claimant auth
      }
    }));
    console.log(`  (Test Client) User ${userUid} successfully created report with valid claimant authorization data.`);
  });
  // Test 41: Deny report creation if claimantSignature is present but claimantAuthDate is empty
  it("should deny report creation if claimantSignature is present but claimantAuthDate is empty", async () => {
    const userUid = "invalidClaimantAuthCreate1";
    const reportId = "KLM-InvalidClaimantAuthCreate1";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 10,
      description: "Test report",
      authorization: {
        approverSignature: '', approverAuthDate: '',
        claimantSignature: 'Claimed', claimantAuthDate: '' // Invalid claimant auth
      }
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with incomplete claimant data.`);
  });

  // Test 42: Deny report creation if claimantAuthDate has invalid format
  it("should deny report creation if claimantAuthDate has invalid format", async () => {
    const userUid = "invalidClaimantAuthCreate2";
    const reportId = "KLM-InvalidClaimantAuthCreate2";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertFails(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 20,
      description: "Test report",
      authorization: {
        approverSignature: '', approverAuthDate: '',
        claimantSignature: 'Claimed', claimantAuthDate: 'Invalid Date' // Invalid claimant date format
      }
    }));
    console.log(`  (Test Client) User ${userUid} correctly denied creating report with invalid claimant date format.`);
  });

  // Test 43: Allow report creation with valid (non-empty) claimant authorization data
  it("should allow report creation with valid claimant authorization data", async () => {
    const userUid = "validClaimantAuthCreate";
    const reportId = "KLM-ValidClaimantAuthCreate";
    const REPORT_FULL_PATH = `${REPORT_PATH_BASE}/${reportId}`;

    const userDb = testEnv.authenticatedContext(userUid).firestore();

    await assertSucceeds(userDb.doc(REPORT_FULL_PATH).set({
      submittedByUserId: userUid,
      amount: 30,
      description: "Test report with claimant signature",
      authorization: {
        approverSignature: '', approverAuthDate: '',
        claimantSignature: 'User Sign', claimantAuthDate: '2023-10-21' // Valid claimant auth
      }
    }));
    console.log(`  (Test Client) User ${userUid} successfully created report with valid claimant authorization data.`);
  });

}); // Closing brace for "Reports Collection Rules" describe block

// --- NEW DESCRIBE BLOCK FOR ROLES COLLECTION RULES ---
describe("Roles Collection Rules", () => {
  const EMULATOR_APP_ID = "emulator-app-id";
  const ROLES_PATH_BASE = `artifacts/${EMULATOR_APP_ID}/public/data/roles`;

  // --- beforeEach for Roles Collection Rules ---
  // Ensure the admin and supervisor roles are set up for tests in this block.
  beforeEach(async () => {
    await adminDb.doc(`${ROLES_PATH_BASE}/adminTestUser123`).set({
      isAdmin: true,
      isSupervisor: true
    });
    await adminDb.doc(`${ROLES_PATH_BASE}/supervisorOnlyUser`).set({
      isAdmin: false,
      isSupervisor: true
    });
    // Create a regular user who is neither admin nor supervisor
    await adminDb.doc(`${ROLES_PATH_BASE}/regularUser`).set({
      isAdmin: false,
      isSupervisor: false
    });
    console.log(`  (Admin SDK) Re-created roles for adminTestUser123, supervisorOnlyUser, and regularUser before Roles tests.`);
  });

  // Test 1: Authenticated user can read their own roles document
  it("should allow an authenticated user to read their own roles document", async () => {
    const userUid = "regularUser"; // User whose roles document we're testing
    const userDb = testEnv.authenticatedContext(userUid).firestore();
    const roleDocRef = userDb.doc(`${ROLES_PATH_BASE}/${userUid}`);
    await assertSucceeds(roleDocRef.get());
    console.log(`  (Test Client) User ${userUid} successfully read their own roles document.`);
  });

  // Test 2: Authenticated user cannot read another user's roles document
  it("should deny an authenticated user from reading another user's roles document", async () => {
    const userUid = "regularUser";
    const otherUserUid = "supervisorOnlyUser"; // Another user's roles document
    const userDb = testEnv.authenticatedContext(userUid).firestore();
    const roleDocRef = userDb.doc(`${ROLES_PATH_BASE}/${otherUserUid}`);
    await assertFails(roleDocRef.get());
    console.log(`  (Test Client) User ${userUid} correctly denied reading ${otherUserUid}'s roles document.`);
  });

  // Test 3: Admin can create a new roles document for any user
  it("should allow an admin to create a new roles document for any user", async () => {
    const adminUid = "adminTestUser123";
    const newUserUid = "newlyCreatedUser";
    const adminDbClient = testEnv.authenticatedContext(adminUid, { isAdmin: true }).firestore();
    const newRoleDocRef = adminDbClient.doc(`${ROLES_PATH_BASE}/${newUserUid}`);
    await assertSucceeds(newRoleDocRef.set({ isAdmin: false, isSupervisor: false }));
    console.log(`  (Test Client) Admin ${adminUid} successfully created roles document for ${newUserUid}.`);
  });

  // Test 4: Non-admin (regular user) cannot create a roles document
  it("should deny a non-admin (regular user) from creating a roles document", async () => {
    const regularUserUid = "regularUser";
    const newUserUid = "unauthorizedNewUser";
    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();
    const newRoleDocRef = regularUserDb.doc(`${ROLES_PATH_BASE}/${newUserUid}`);
    await assertFails(newRoleDocRef.set({ isAdmin: false, isSupervisor: false }));
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied creating roles document for ${newUserUid}.`);
  });

  // Test 5: Admin can update an existing roles document for any user
  it("should allow an admin to update an existing roles document for any user", async () => {
    const adminUid = "adminTestUser123";
    const targetUserUid = "regularUser"; // We'll update the regular user's roles
    const adminDbClient = testEnv.authenticatedContext(adminUid, { isAdmin: true }).firestore();
    const targetRoleDocRef = adminDbClient.doc(`${ROLES_PATH_BASE}/${targetUserUid}`);
    await assertSucceeds(targetRoleDocRef.update({ isSupervisor: true }));
    console.log(`  (Test Client) Admin ${adminUid} successfully updated roles for ${targetUserUid}.`);
  });

  // Test 6: Non-admin (supervisor) cannot update another user's roles document
  it("should deny a non-admin (supervisor) from updating another user's roles document", async () => {
    const supervisorUid = "supervisorOnlyUser";
    const targetUserUid = "regularUser";
    const supervisorDbClient = testEnv.authenticatedContext(supervisorUid, { isSupervisor: true }).firestore();
    const targetRoleDocRef = supervisorDbClient.doc(`${ROLES_PATH_BASE}/${targetUserUid}`);
    await assertFails(targetRoleDocRef.update({ isSupervisor: true }));
    console.log(`  (Test Client) Supervisor ${supervisorUid} correctly denied updating roles for ${targetUserUid}.`);
  });

  // Test 7: Admin can delete an existing roles document for any user
  it("should allow an admin to delete an existing roles document for any user", async () => {
    const adminUid = "adminTestUser123";
    const targetUserUid = "regularUser";
    const adminDbClient = testEnv.authenticatedContext(adminUid, { isAdmin: true }).firestore();
    const targetRoleDocRef = adminDbClient.doc(`${ROLES_PATH_BASE}/${targetUserUid}`);
    await assertSucceeds(targetRoleDocRef.delete());
    console.log(`  (Test Client) Admin ${adminUid} successfully deleted roles document for ${targetUserUid}.`);
  });

  // Test 8: Non-admin (regular user) cannot delete a roles document
  it("should deny a non-admin (regular user) from deleting a roles document", async () => {
    const regularUserUid = "regularUser";
    const targetUserUid = "supervisorOnlyUser"; // Try to delete supervisor's roles
    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();
    const targetRoleDocRef = regularUserDb.doc(`${ROLES_PATH_BASE}/${targetUserUid}`);
    await assertFails(targetRoleDocRef.delete());
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied deleting roles document for ${targetUserUid}.`);
  });
  
  // Test 9: Non-admin (regular user) cannot manage their OWN roles document (create/update/delete)
  it("should deny a non-admin from managing their OWN roles document (create/update/delete)", async () => {
    const regularUserUid = "regularUser";
    const regularUserDb = testEnv.authenticatedContext(regularUserUid).firestore();
    const ownRoleDocRef = regularUserDb.doc(`${ROLES_PATH_BASE}/${regularUserUid}`);

    // Try to create/set their own roles (should fail)
    await assertFails(ownRoleDocRef.set({ isAdmin: false, isSupervisor: false }));
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied creating/setting their own roles document.`);

    // Try to update their own roles (should fail)
    await assertFails(ownRoleDocRef.update({ isSupervisor: true }));
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied updating their own roles document.`);

    // Try to delete their own roles (should fail)
    await assertFails(ownRoleDocRef.delete());
    console.log(`  (Test Client) Regular user ${regularUserUid} correctly denied deleting their own roles document.`);
  });

    // Test 10: Admin can read another user's roles document (new rule behavior)
    it("should allow an Admin to read another user's roles document", async () => {
      const adminUid = "adminTestUser123";
      const targetUserUid = "regularUser"; // Admin will try to read this user's roles
      const adminDbClient = testEnv.authenticatedContext(adminUid, { isAdmin: true }).firestore();
      const targetRoleDocRef = adminDbClient.doc(`${ROLES_PATH_BASE}/${targetUserUid}`);
      await assertSucceeds(targetRoleDocRef.get()); // Changed from assertFails to assertSucceeds
      console.log(`  (Test Client) Admin ${adminUid} successfully read ${targetUserUid}'s roles document.`);
    });
  // Test 11: Authenticated user can attempt to read their own (potentially non-existent) roles document
  it("should allow an authenticated user to attempt to read their own roles document (even if it doesn't exist)", async () => {
    const userWithoutRolesUid = "userWithoutRoles3";
    // IMPORTANT: DO NOT create a roles document for userWithoutRolesUid

    const rolesDocRef = testEnv.authenticatedContext(userWithoutRolesUid).firestore().doc(`${ROLES_PATH_BASE}/${userWithoutRolesUid}`);

    // This should SUCCEED because the rule allows reading your own document,
    // regardless of whether it physically exists in the database.
    // The resulting snapshot will simply have .exists() == false.
    await assertSucceeds(rolesDocRef.get());
    console.log(`  (Test Client) User ${userWithoutRolesUid} successfully attempted to read their own roles document (may not exist).`);
  });
}); // Closing brace for "Roles Collection Rules" describe block
