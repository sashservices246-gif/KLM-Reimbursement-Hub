// --- START: Core Firebase Functions/Admin Imports & Setup ---
import * as admin from "firebase-admin";
import {setGlobalOptions, logger} from "firebase-functions";
import {Storage} from "@google-cloud/storage"; // NEW: Import Storage
import {onSchedule} from "firebase-functions/v2/scheduler";

// These are the v2 Firestore trigger imports
import { // Split for max-len compliance
  onDocumentUpdated,
  onDocumentWritten,
  FirestoreEvent,
  Change,
} from "firebase-functions/v2/firestore";

// Import specific Firestore types from firebase-admin
import { // Split for max-len compliance
  DocumentSnapshot,
} from "firebase-admin/firestore";

// Initialize the Firebase Admin SDK
admin.initializeApp();
// --- END: Core Firebase Functions/Admin Imports & Setup ---

// For cost control, set max instances
setGlobalOptions({maxInstances: 10});

// Define an interface for the Report document data
interface ReportData {
  submittedByUserId: string;
  amount: number;
  description: string;
  authorization: {
    approverSignature: string;
    approverAuthDate: string;
    claimantSignature: string;
    claimantAuthDate: string;
  };
  proxySubmitterId?: string;
  oldTemporaryReportId?: string; // NEW: Added for the rename function
}

// Define a type alias for the update payload
type AuthorizationUpdatePayload = {
  "authorization.approverAuthDate"?: string;
  "authorization.claimantAuthDate"?: string;
};

// --- START: New Interfaces for Email Function ---
// These interfaces provide detailed types for report data
// used by the email notification function.
interface ClaimantInfo {
  name: string;
  email: string;
  period: string;
  submitted: string;
}

interface ReportTotals {
  totalExpenses: number;
  totalAdvance: number;
  totalDue: number;
}

interface ReportAuthorization {
  approverSignature: string;
  approverAuthDate: string;
  claimantSignature: string;
  claimantAuthDate: string;
}

// --- ADD THIS NEW INTERFACE ---
interface Expense {
  date: string;
  vendor: string;
  description: string;
  category: string;
  class_code: string;
  amount: number;
  receipt_url?: string; // Optional if not always present
}
// --- END NEW INTERFACE ---

// This comprehensive interface represents the full Firestore report document
interface ReportDocumentData {
  submittedByUserId: string;
  amount: number;
  description: string;
  claimantInfo?: ClaimantInfo;
  expenses?: Expense[]; // Consider defining a more specific Expense interface
  totals?: ReportTotals;
  authorization?: ReportAuthorization;
  timestamp: number;
  proxySubmitterId?: string;
  oldTemporaryReportId?: string;
}
// --- END: New Interfaces for Email Function ---

// --- START: autoPopulateAuthDates Cloud Function (v2 API) ---
/**
 * Cloud Function to automatically set authorization dates when
 * signatures are provided.
 *
 * This function triggers on updates to documents in the 'reports'
 * sub-collection located under
 * 'artifacts/{appId}/public/data/reports/{reportId}'.
 *
 * It checks if 'approverSignature' or 'claimantSignature' have been
 * added/changed from an empty string to a non-empty string, and if their
 * corresponding date fields ('approverAuthDate' or 'claimantAuthDate')
 * are currently empty. If so, it updates the date field to the current date
 * in 'YYYY-MM-DD' format.
 */
export const autoPopulateAuthDates = onDocumentUpdated(
  "artifacts/{appId}/public/data/reports/{reportId}",
  async (
    event: FirestoreEvent<
      Change<DocumentSnapshot> | undefined,
      { appId: string; reportId: string }
    >,
  ) => {
    const oldData = (event.data?.before?.data() as ReportData) || undefined;
    const newData = (event.data?.after?.data() as ReportData) || undefined;

    const reportRef = event.data?.after?.ref || event.data?.before?.ref;

    if (!reportRef || !newData) {
      logger.log(
        "No document reference or new data found in event. Exiting function.",
      );
      return null;
    }

    const getFormattedDate = () => {
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    const formattedDate = getFormattedDate();
    let updateNeeded = false;
    const updatePayload: AuthorizationUpdatePayload = {};

    const emptyAuth = {
      approverSignature: "",
      approverAuthDate: "",
      claimantSignature: "",
      claimantAuthDate: "",
    };
    const oldAuthorization = oldData?.authorization || emptyAuth;
    const newAuthorization = newData.authorization || emptyAuth;

    // --- 1. Check for Approver Signature and Date ---
    const oldApproverSignature = oldAuthorization.approverSignature;
    const newApproverSignature = newAuthorization.approverSignature;
    const newApproverAuthDate = newAuthorization.approverAuthDate;

    const isApproverSignatureBeingSet =
      oldApproverSignature === "" &&
      newApproverSignature !== "" &&
      newApproverAuthDate === "";

    if (isApproverSignatureBeingSet) {
      logger.log("Approver signature added, setting approverAuthDate.");
      updatePayload["authorization.approverAuthDate"] = formattedDate;
      updateNeeded = true;
    } else if (
      oldApproverSignature !== "" &&
      newApproverSignature === "" &&
      newApproverAuthDate !== ""
    ) {
      logger.log("Approver signature cleared, clearing approverAuthDate.");
      updatePayload["authorization.approverAuthDate"] = "";
      updateNeeded = true;
    }

    // --- 2. Check for Claimant Signature and Date ---
    const oldClaimantSignature = oldAuthorization.claimantSignature;
    const newClaimantSignature = newAuthorization.claimantSignature;
    const newClaimantAuthDate = newAuthorization.claimantAuthDate;
    // Fixed: was newAuthorization.approverAuthDate

    const isClaimantSignatureBeingSet =
      oldClaimantSignature === "" &&
      newClaimantSignature !== "" &&
      newClaimantAuthDate === "";

    if (isClaimantSignatureBeingSet) {
      logger.log("Claimant signature added, setting claimantAuthDate.");
      updatePayload["authorization.claimantAuthDate"] = formattedDate;
      updateNeeded = true;
    } else if (
      oldClaimantSignature !== "" &&
      newClaimantSignature === "" &&
      newClaimantAuthDate !== ""
    ) {
      logger.log("Claimant signature cleared, clearing claimantAuthDate.");
      updatePayload["authorization.claimantAuthDate"] = "";
      updateNeeded = true;
    }

    if (updateNeeded) {
      logger.log("Updating document with authorization dates:", updatePayload);
      await reportRef.update(updatePayload);
      logger.log("Authorization dates updated successfully.");
    } else {
      logger.log("No authorization date updates needed for report:",
        reportRef.path,
      );
    }

    return null;
  },
);
// --- END: autoPopulateAuthDates Cloud Function ---


// --- START: renameReceiptFolderOnReportUpdate Cloud Function ---
const storageClient = new Storage(); // Instantiate the Storage client once

/**
 * Cloud Function to rename Firebase Storage folders when a Firestore report
 * transitions from a temporary ID to a permanent ID.
 *
 * This function triggers on updates to documents in the 'reports'
 * sub-collection located under
 * 'artifacts/{appId}/public/data/reports/{reportId}'.
 * It looks for the 'oldTemporaryReportId' field to determine if a rename
 * is needed.
 */
export const renameReceiptFolderOnReportUpdate = onDocumentUpdated(
  "artifacts/{appId}/public/data/reports/{reportId}",
  async (event) => {
    const newReportData = event.data?.after?.data() as ReportData | undefined;
    const oldReportData = event.data?.before?.data() as ReportData | undefined;
    const {appId, reportId} = event.params;

    if (!newReportData || !oldReportData) {
      logger.log("No old or new data found in event. Skipping Storage rename.");
      return null;
    }

    const oldTemporaryReportId = oldReportData.oldTemporaryReportId;

    if (oldTemporaryReportId &&
        oldTemporaryReportId.startsWith("KLM-TEMP-") &&
        oldTemporaryReportId !== reportId
    ) {
      logger.log(
        `Detected report ID change for appId: ${appId}, ` +
        `User: ${newReportData.submittedByUserId}`,
      );
      logger.log(
        `Moving receipts from temporary ID: ${oldTemporaryReportId} ` +
        `to permanent ID: ${reportId}`,
      );

      const userId = newReportData.submittedByUserId;
      if (!userId) {
        logger.error(
          "SubmittedByUserId not found in report data. " +
          "Cannot move receipts for reportId:", reportId,
        );
        return null;
      }

      const bucket = storageClient.bucket(admin.storage().bucket().name);

      const oldPrefix = `receipts/${appId}/${userId}/${oldTemporaryReportId}/`;
      const newPrefix = `receipts/${appId}/${userId}/${reportId}/`;

      try {
        const [files] = await bucket.getFiles({prefix: oldPrefix});

        if (files.length === 0) {
          logger.log(
            `No receipts found for temporary ID: ${oldTemporaryReportId} ` +
            `at prefix ${oldPrefix}`,
          );
          await event.data?.after?.ref.update(
            {oldTemporaryReportId: admin.firestore.FieldValue.delete()},
          );
          logger.log(
            "Removed oldTemporaryReportId field from Firestore document " +
            `${reportId} (no receipts to move).`,
          );
          return null;
        }

        const moveOperations = files.map(async (file) => {
          const newFileName = file.name.replace(oldPrefix, newPrefix);
          const newFile = bucket.file(newFileName);

          await file.copy(newFile);
          logger.log(`Copied ${file.name} to ${newFile.name}`);

          await file.delete();
          logger.log(`Deleted original file: ${file.name}`);
        });

        await Promise.all(moveOperations);
        logger.log(`Successfully moved all receipts for report ${reportId}`);

        await event.data?.after?.ref.update(
          {oldTemporaryReportId: admin.firestore.FieldValue.delete()},
        );
        logger.log(
          "Removed oldTemporaryReportId field from Firestore document " +
          `${reportId}`,
        );
      } catch (error) {
        logger.error(
          `Error moving receipts for report ${reportId} from ${oldPrefix} ` +
          `to ${newPrefix}:`, error,
        );
      }
    } else {
      logger.log(
        `Not a temporary ID transition for report ${reportId}. ` +
        `oldTemporaryReportId: ${oldTemporaryReportId}. ` +
        "Skipping Storage rename.",
      );
    }

    return null;
  },
);
// --- END: renameReceiptFolderOnReportUpdate Cloud Function ---

// --- START: sendReportNotificationEmails Cloud Function (v2 API) ---
/**
 * Cloud Function to send email notifications based on report status changes
 * (new submission or approval).
 *
 * This function triggers on updates to documents in the 'reports'
 * sub-collection located under
 * 'artifacts/{appId}/public/data/reports/{reportId}'.
 *
 * It sends different emails based on:
 * - If it's a new report submission.
 * - If an approver has just signed off on a report.
 * - Routes initial submission emails to specific approvers based on claimant.
 * - Sends approval confirmation to claimant and Kim.
 * - Sends a "FYI" email to the other potential approver if one has
 *   already approved.
 */
export const sendReportNotificationEmails = onDocumentWritten(
  "artifacts/{appId}/public/data/reports/{reportId}",
  async (
    event: FirestoreEvent<
      Change<DocumentSnapshot> | undefined,
      { appId: string; reportId: string }
    >,
  ) => {
    // --- MOVE THESE LINES HERE ---
    const {reportId} = event.params; // <-- MOVED HERE

    try { // <-- START TRY BLOCK HERE
      const beforeData =
      event.data?.before?.data() as ReportDocumentData | undefined;
      const afterData =
      event.data?.after?.data() as ReportDocumentData | undefined;

      const reportRef = event.data?.after?.ref;

      if (!reportRef || !afterData) {
        logger.log(
          "No document reference or new data found for email event. Exiting.",
        );
        return null;
      }

      const claimantEmail = afterData.claimantInfo?.email;
      const claimantName = afterData.claimantInfo?.name;
      const totalExpenses = afterData.totals?.totalExpenses || 0;

      // Define key email addresses
      const floydEmail = "floyd.mccollin@kingdomlifeministriesbb.com";
      const elsworthEmail = "elsworth.howell@kingdomlifeministriesbb.com";
      const dwayneEmail = "dwayne.headley@kingdomlifeministriesbb.com";
      const kimEmail = "kim.griffith@kingdomlifeministriesbb.com";
      const adminEmail = "admin@kingdomlifeministriesbb.com";

      // Helper to add email to the mail subcollection
      const sendMail = async (
        to: { email: string }[],
        subject: string,
        html: string,
        text: string,
      ) => {
      // Create a reference to the 'mail' subcollection *within*
      // the saved report document
        const mailCollectionRef = reportRef.collection("mail");
        await mailCollectionRef.add({to, subject, html, text});
        logger.log(
          `Email document created for report ${reportId}. Subject: ${subject}`,
        );
      };

      // --- Logic to detect new submission vs. approval ---
      // A report is considered 'newly submitted' if it didn't exist before
      // or if `claimantSignature` was just set, and `approverSignature`
      // is still empty.

      const isDocumentCreation = !beforeData;

      // Check if claimant signature was just set and approver signature is
      // empty
      const claimantSignedFirstTime =
      beforeData &&
      !beforeData.authorization?.claimantSignature &&
      afterData.authorization?.claimantSignature &&
      !afterData.authorization?.approverSignature;

      // A report is an initial submission if it's a document creation
      // AND has a claimant email AND no approver signature.
      // OR if claimant signature was just set and no approver signature.
      const isInitialSubmission =
      (isDocumentCreation &&
        claimantEmail && // ensure claimant email is present
        !afterData.authorization?.approverSignature) ||
      claimantSignedFirstTime;

      // An approval occurs when approverSignature changes from empty to
      // non-empty
      const wasNotApprovedBefore =
      beforeData && !beforeData.authorization?.approverSignature;
      const isNowApproved = afterData.authorization?.approverSignature !== "";
      const isApprovalAction = wasNotApprovedBefore && isNowApproved;

      // --- Handle New Report Submission Emails ---
      if (isInitialSubmission) {
        logger.log(`Processing new report submission for ${reportId}`);
        let submissionRecipients: { email: string }[] = [];

        if (claimantEmail === floydEmail) {
          submissionRecipients = [{email: elsworthEmail},
            {email: dwayneEmail}];
        } else if (claimantEmail === dwayneEmail) {
          submissionRecipients = [{email: floydEmail},
            {email: elsworthEmail}];
        } else {
          submissionRecipients = [{email: floydEmail},
            {email: dwayneEmail}];
        }

        const subject = `New Reimbursement Report Submitted: ${reportId}`;
        const htmlBody = `
        <p>Hello Finance Team,</p>
        <p>A new reimbursement report (ID: <strong>${reportId}</strong>) has
        been submitted.</p>
        <p><strong>Claimant Name:</strong> ${claimantName}</p>
        <p><strong>Claimant Email:</strong> ${claimantEmail}</p>
        <p><strong>Claim Period:</strong> ${afterData.claimantInfo?.period}
        </p>
        <p><strong>Total Claimed:</strong> $${totalExpenses.toFixed(2)}</p>
        <p>Please review the report in the admin panel.</p>
        <p>Thank you,</p>
        <p>KLM Reimbursement Hub Automated System</p>
      `;
        const textBody = `
        Hello Finance Team,

        A new reimbursement report (ID: ${reportId}) has been submitted.

        Claimant Name: ${claimantName}
        Claimant Email: ${claimantEmail}
        Claim Period: ${afterData.claimantInfo?.period}
        Total Claimed: $${totalExpenses.toFixed(2)}

        Please review the report in the admin panel.

        Thank you,
        KLM Reimbursement Hub Automated System
      `;
        // Ensure claimantEmail is a string before using it in the `to` field
        if (submissionRecipients.length > 0 && claimantEmail) {
          // Add claimantEmail check here
          await sendMail(submissionRecipients, subject, htmlBody, textBody);
        } else {
          logger.log(
            `Skipping submission email for report ${reportId} due to missing ` +
            "recipients or claimant email."
          );
        }
      }

      // --- Handle Approval Emails ---
      if (isApprovalAction) {
        logger.log(`Processing approval action for report ${reportId}`);
        const approverSignature = afterData.authorization?.approverSignature;
        const approverAuthDate = afterData.authorization?.approverAuthDate;

        // 1. Send approval email to Claimant
        // Ensure claimantEmail is a string before trying to send to them
        if (claimantEmail) { // Add this check
          await sendMail(
            [{email: claimantEmail}],
            `Your Reimbursement Report Approved: ${reportId}`,
            `
          <p>Hello ${claimantName},</p>
          <p>Your reimbursement report (ID: <strong>${reportId}</strong>) has
          been <strong>approved</strong> by a supervisor.</p>
          <p><strong>Claim Period:</strong> ${afterData.claimantInfo?.period}
          </p>
          <p><strong>Total Claimed:</strong> $${totalExpenses.toFixed(2)}</p>
          <p>Approved By: ${approverSignature} on ${approverAuthDate}</p>
          <p>Payment will be processed according to standard procedures.</p>
          <p>Thank you,</p>
          <p>KLM Reimbursement Hub Automated System</p>
        `,
            `
          Hello ${claimantName},

          Your reimbursement report (ID: ${reportId}) has been APPROVED
          by a supervisor.

          Claim Period: ${afterData.claimantInfo?.period}
          Total Claimed: $${totalExpenses.toFixed(2)}
          Approved By: ${approverSignature} on ${approverAuthDate}

          Payment will be processed according to standard procedures.

          Thank you,
          KLM Reimbursement Hub Automated System
        `,
          );
        } else {
          logger.log(
            `Skipping claimant approval email for report ${reportId} as ` +
            "claimantEmail is missing."
          );
        }

        // 2. Send email to Kim Griffith for cheque preparation
        await sendMail(
          [{email: kimEmail}],
          "Action Required: Reimbursement Report Approved for " +
        `Cheque Preparation - ${reportId}`,
          `
          <p>Hello Kim,</p>
          <p>Reimbursement report <strong>${reportId}</strong> for
          <strong>${claimantName}</strong> has been approved by a
          supervisor.</p>
          <p>Please prepare the cheque for <strong>$${totalExpenses.toFixed(
    2,
  )}</strong> as per the approved report.</p>
          <p>Thank you,</p>
          <p>KLM Reimbursement Hub Automated System</p>
        `,
          `
          Hello Kim,

          Reimbursement report ${reportId} for ${claimantName} has been
          approved by a supervisor.
          Please prepare the cheque for $${totalExpenses.toFixed(2)} as per
          the approved report.

          Thank you,
          KLM Reimbursement Hub Automated System
        `,
        );

        // 3. Send separate email to Admin for approval record
        await sendMail(
          [{email: adminEmail}],
          `FYI: Reimbursement Report ${reportId} Approved`,
          `
          <p>Hello Admin Team,</p>
          <p>Reimbursement report <strong>${reportId}</strong> for
          <strong>${claimantName}</strong> has been approved by a supervisor.
          </p>
          <p>Approved By: ${approverSignature} on ${approverAuthDate}</p>
          <p>Total Claimed: $${totalExpenses.toFixed(2)}</p>
          <p>Thank you,</p>
          <p>KLM Reimbursement Hub Automated System</p>
        `,
          `
          Hello Admin Team,

          Reimbursement report ${reportId} for ${claimantName} has been
          approved by a supervisor.
          Approved By: ${approverSignature} on ${approverAuthDate}
          Total Claimed: $${totalExpenses.toFixed(2)}

          Thank you,
          KLM Reimbursement Hub Automated System
        `,
        );

        // 4. Send "FYI" email to the "other" potential approver (if applicable)
        let potentialApproversForClaimant: string[] = [];
        if (claimantEmail === floydEmail) {
          potentialApproversForClaimant = [elsworthEmail, dwayneEmail];
        } else if (claimantEmail === dwayneEmail) {
          potentialApproversForClaimant = [floydEmail, elsworthEmail];
        } else {
          potentialApproversForClaimant = [floydEmail, dwayneEmail];
        }

        // Determine who actually approved based on `approverSignature`
        // This is a simplified check. A robust solution might involve mapping
        // `approverSignature` to user UIDs and then checking
        // `context.auth.uid` if `onUpdate` could reliably provide it.
        // For now, we'll assume the signature contains part of the email for
        // identification.
        const approvingUserEmailPart =
        approverSignature?.toLowerCase().split(" ")[0]; // e.g., 'floyd'

        const otherApproverEmails = potentialApproversForClaimant.filter(
          (email) =>
            !email.toLowerCase().includes(approvingUserEmailPart || "") &&
          !(approverSignature || "")
            .toLowerCase()
            .includes(email.toLowerCase()),
        ).map((email) => ({email}));

        if (otherApproverEmails.length > 0) {
          await sendMail(
            otherApproverEmails,
            `FYI: Reimbursement Report ${reportId} Already Approved`,
            `
            <p>Hello,</p>
            <p>This is an automated notification: Reimbursement report
            <strong>${reportId}</strong> has already been approved by a
            colleague (${approverSignature}).</p>
            <p>No further action is required from you for this report.</p>
            <p>Thank you,</p>
            <p>KLM Reimbursement Hub Automated System</p>
          `,
            `
            Hello,

            This is an automated notification: Reimbursement report ${reportId}
            has already been approved by a colleague (${approverSignature}).
            No further action is required from you for this report.

            Thank you,
            KLM Reimbursement Hub Automated System
          `,
          );
        }
      }

      return null;
    } catch (error) { // <-- CATCH BLOCK
      logger.error(
        "[EmailFcn ERROR] Uncaught error in function for report " +
        `${reportId || "unknown"}: `, error
      );
      return null;
    }
  },
);
// --- END: sendReportNotificationEmails Cloud Function ---

// --- START: sendMonthlyReportSummary Cloud Function (Scheduled) ---
/**
 * Cloud Function to send a monthly summary of reports.
 * Runs on the 1st day of every month at 09:00 (9 AM) UTC.
 */
export const sendMonthlyReportSummary = onSchedule(
  {
    schedule: "0 9 1 * *", // Run at 09:00 UTC on day 1 of every month
    timeZone: "America/Barbados", // Adjust to your desired timezone
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async (_event) => {
    logger.log("[Monthly Summary] Function started.");

    const adminEmail = "admin@kingdomlifeministriesbb.com"; // Admin recipient

    // --- Dynamic App ID Selection ---
    const productionAppId = "1:1023984160721:web:0a89f18a92a259e8b1af0";
    const isEmulatorEnv = process.env.FUNCTIONS_EMULATOR === "true";
    const currentAppId = isEmulatorEnv ? "emulator-app-id" : productionAppId;
    // --- END Dynamic App ID Selection ---

    const reportsRef = admin.firestore()
      .collection("artifacts")
      .doc(currentAppId)
      .collection("public")
      .doc("data")
      .collection("reports");

    // Calculate date range for the *previous* month
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    const startOfCurrentMonth = new Date(currentYear, currentMonth, 1);

    const startOfPreviousMonth = new Date(startOfCurrentMonth);
    startOfPreviousMonth.setMonth(startOfPreviousMonth.getMonth() - 1);

    const endOfPreviousMonth = new Date(startOfCurrentMonth);
    endOfPreviousMonth.setDate(endOfPreviousMonth.getDate() - 1);

    logger.log(
      "[Monthly Summary] Querying reports from " +
      `${startOfPreviousMonth.toISOString()} to ` +
      `${endOfPreviousMonth.toISOString()} for appId: ${currentAppId}`
    );

    try {
      const snapshot = await reportsRef
        .where("timestamp", ">=", startOfPreviousMonth.getTime())
        .where("timestamp", "<=", endOfPreviousMonth.getTime())
        .get();

      if (snapshot.empty) {
        logger.log(
          "[Monthly Summary] Querying reports from " +
          `${startOfPreviousMonth.toISOString()} to ` +
          `${endOfPreviousMonth.toISOString()} for appId: ${currentAppId}`
        );
        // If no reports, simply return to fulfill Promise<void>
        return; // <-- CHANGED FROM return null;
      }

      let totalReports = 0;
      let totalAmountClaimed = 0;
      const reportSummaries: string[] = [];

      snapshot.forEach((doc) => {
        const data = doc.data() as ReportDocumentData;
        totalReports++;
        totalAmountClaimed += data.amount || 0;
        reportSummaries.push(
          `- Report ID: ${doc.id}, Claimant: ${data.claimantInfo?.name}, ` +
          `Amount: $${(data.amount || 0).toFixed(2)}`
        );
      });

      const subject = "Monthly Reimbursement Report Summary - " +
                      `${startOfPreviousMonth.toLocaleString("en-US", {
                        month: "long",
                        year: "numeric",
                      })}`;
      const htmlBody = `
        <p>Hello Admin Team,</p>
        <p>Here is a summary of reimbursement reports created in ` +
        `${startOfPreviousMonth.toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        })}:</p>
        <p><strong>Total Reports:</strong> ${totalReports}</p>
        <p><strong>Total Amount Claimed:</strong> ` +
        `$${totalAmountClaimed.toFixed(2)}</p>
        <p><strong>Details:</strong></p>
        <ul>
          ${reportSummaries.map((s) => `<li>${s}</li>`).join("")}
        </ul>
        <p>Please log into the Reimbursement Hub to review these reports.</p>
        <p>Thank you,</p>
        <p>KLM Reimbursement Hub Automated System</p>
      `;
      const textBody = `
        Hello Admin Team,

        Here is a summary of reimbursement reports created in ` +
        `${startOfPreviousMonth.toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        })}:

        Total Reports: ${totalReports}
        Total Amount Claimed: $${totalAmountClaimed.toFixed(2)}

        Details:
        ${reportSummaries.join("\n")}

        Please log into the Reimbursement Hub to review these reports.

        Thank you,
        KLM Reimbursement Hub Automated System
      `;

      const mailCollectionRef = admin.firestore().collection("mail");
      await mailCollectionRef.add({
        to: [{email: adminEmail}],
        subject,
        html: htmlBody,
        text: textBody,
      });

      logger.log("[Monthly Summary] Email sent successfully to admin.");
    } catch (error) {
      logger.error("[Monthly Summary] Error generating report:", error);
    }
    // Explicitly return to satisfy Promise<void>
    return; // <-- CHANGED FROM return null;
  }
);
// --- END: sendMonthlyReportSummary Cloud Function ---
