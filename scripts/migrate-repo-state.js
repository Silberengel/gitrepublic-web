#!/usr/bin/env node
/**
 * Migration script to update state references in +page.svelte
 * This helps automate the bulk replacement of old state variable references
 * with the new nested state structure.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const targetFile = join(rootDir, 'src/routes/repos/[npub]/[repo]/+page.svelte');

// Migration mappings: old reference -> new reference
const migrations = [
  // Loading states
  { pattern: /\bloading\b/g, replacement: 'state.loading.main' },
  { pattern: /\bloadingReadme\b/g, replacement: 'state.loading.readme' },
  { pattern: /\bloadingCommits\b/g, replacement: 'state.loading.commits' },
  { pattern: /\bloadingIssues\b/g, replacement: 'state.loading.issues' },
  { pattern: /\bloadingIssueReplies\b/g, replacement: 'state.loading.issueReplies' },
  { pattern: /\bloadingPRs\b/g, replacement: 'state.loading.prs' },
  { pattern: /\bloadingPatches\b/g, replacement: 'state.loading.patches' },
  { pattern: /\bloadingPatchHighlights\b/g, replacement: 'state.loading.patchHighlights' },
  { pattern: /\bloadingDocs\b/g, replacement: 'state.loading.docs' },
  { pattern: /\bloadingDiscussions\b/g, replacement: 'state.loading.discussions' },
  { pattern: /\bloadingReleases\b/g, replacement: 'state.loading.releases' },
  { pattern: /\bloadingCodeSearch\b/g, replacement: 'state.loading.codeSearch' },
  { pattern: /\bloadingBookmark\b/g, replacement: 'state.loading.bookmark' },
  { pattern: /\bloadingMaintainerStatus\b/g, replacement: 'state.loading.maintainerStatus' },
  { pattern: /\bloadingMaintainers\b/g, replacement: 'state.loading.maintainers' },
  { pattern: /\bloadingReachability\b/g, replacement: 'state.loading.reachability' },
  { pattern: /\bloadingVerification\b/g, replacement: 'state.loading.verification' },
  
  // UI state
  { pattern: /\bactiveTab\b/g, replacement: 'state.ui.activeTab' },
  { pattern: /\bshowRepoMenu\b/g, replacement: 'state.ui.showRepoMenu' },
  { pattern: /\bshowFileListOnMobile\b/g, replacement: 'state.ui.showFileListOnMobile' },
  { pattern: /\bshowLeftPanelOnMobile\b/g, replacement: 'state.ui.showLeftPanelOnMobile' },
  { pattern: /\bwordWrap\b/g, replacement: 'state.ui.wordWrap' },
  { pattern: /\bexpandedThreads\b/g, replacement: 'state.ui.expandedThreads' },
  
  // User state
  { pattern: /\buserPubkey\b/g, replacement: 'state.user.pubkey' },
  { pattern: /\buserPubkeyHex\b/g, replacement: 'state.user.pubkeyHex' },
  
  // Files
  { pattern: /\bfiles\b/g, replacement: 'state.files.list' },
  { pattern: /\bcurrentPath\b/g, replacement: 'state.files.currentPath' },
  { pattern: /\bcurrentFile\b/g, replacement: 'state.files.currentFile' },
  { pattern: /\bfileContent\b/g, replacement: 'state.files.content' },
  { pattern: /\bfileLanguage\b/g, replacement: 'state.files.language' },
  { pattern: /\beditedContent\b/g, replacement: 'state.files.editedContent' },
  { pattern: /\bhasChanges\b/g, replacement: 'state.files.hasChanges' },
  { pattern: /\bpathStack\b/g, replacement: 'state.files.pathStack' },
  
  // Preview
  { pattern: /\breadmeContent\b/g, replacement: 'state.preview.readme.content' },
  { pattern: /\breadmePath\b/g, replacement: 'state.preview.readme.path' },
  { pattern: /\breadmeIsMarkdown\b/g, replacement: 'state.preview.readme.isMarkdown' },
  { pattern: /\breadmeHtml\b/g, replacement: 'state.preview.readme.html' },
  { pattern: /\bhighlightedFileContent\b/g, replacement: 'state.preview.file.highlightedContent' },
  { pattern: /\bfileHtml\b/g, replacement: 'state.preview.file.html' },
  { pattern: /\bshowFilePreview\b/g, replacement: 'state.preview.file.showPreview' },
  { pattern: /\bcopyingFile\b/g, replacement: 'state.preview.copying' },
  { pattern: /\bisImageFile\b/g, replacement: 'state.preview.file.isImage' },
  { pattern: /\bimageUrl\b/g, replacement: 'state.preview.file.imageUrl' },
  
  // Git
  { pattern: /\bbranches\b/g, replacement: 'state.git.branches' },
  { pattern: /\bcurrentBranch\b/g, replacement: 'state.git.currentBranch' },
  { pattern: /\bdefaultBranch\b/g, replacement: 'state.git.defaultBranch' },
  { pattern: /\bcommits\b/g, replacement: 'state.git.commits' },
  { pattern: /\bselectedCommit\b/g, replacement: 'state.git.selectedCommit' },
  { pattern: /\bshowDiff\b/g, replacement: 'state.git.showDiff' },
  { pattern: /\bdiffData\b/g, replacement: 'state.git.diffData' },
  { pattern: /\bverifyingCommits\b/g, replacement: 'state.git.verifyingCommits' },
  { pattern: /\btags\b/g, replacement: 'state.git.tags' },
  { pattern: /\bselectedTag\b/g, replacement: 'state.git.selectedTag' },
  
  // Forms
  { pattern: /\bnewFileName\b/g, replacement: 'state.forms.file.fileName' },
  { pattern: /\bnewFileContent\b/g, replacement: 'state.forms.file.content' },
  { pattern: /\bnewBranchName\b/g, replacement: 'state.forms.branch.name' },
  { pattern: /\bnewBranchFrom\b/g, replacement: 'state.forms.branch.from' },
  { pattern: /\bdefaultBranchName\b/g, replacement: 'state.forms.branch.defaultName' },
  { pattern: /\bnewTagName\b/g, replacement: 'state.forms.tag.name' },
  { pattern: /\bnewTagMessage\b/g, replacement: 'state.forms.tag.message' },
  { pattern: /\bnewTagRef\b/g, replacement: 'state.forms.tag.ref' },
  { pattern: /\bcommitMessage\b/g, replacement: 'state.forms.commit.message' },
  { pattern: /\bnewIssueSubject\b/g, replacement: 'state.forms.issue.subject' },
  { pattern: /\bnewIssueContent\b/g, replacement: 'state.forms.issue.content' },
  { pattern: /\bnewIssueLabels\b/g, replacement: 'state.forms.issue.labels' },
  { pattern: /\bnewPRSubject\b/g, replacement: 'state.forms.pr.subject' },
  { pattern: /\bnewPRContent\b/g, replacement: 'state.forms.pr.content' },
  { pattern: /\bnewPRCommitId\b/g, replacement: 'state.forms.pr.commitId' },
  { pattern: /\bnewPRBranchName\b/g, replacement: 'state.forms.pr.branchName' },
  { pattern: /\bnewPRLabels\b/g, replacement: 'state.forms.pr.labels' },
  { pattern: /\bnewPatchContent\b/g, replacement: 'state.forms.patch.content' },
  { pattern: /\bnewPatchSubject\b/g, replacement: 'state.forms.patch.subject' },
  { pattern: /\bnewReleaseTagName\b/g, replacement: 'state.forms.release.tagName' },
  { pattern: /\bnewReleaseTagHash\b/g, replacement: 'state.forms.release.tagHash' },
  { pattern: /\bnewReleaseNotes\b/g, replacement: 'state.forms.release.notes' },
  { pattern: /\bnewReleaseIsDraft\b/g, replacement: 'state.forms.release.isDraft' },
  { pattern: /\bnewReleaseIsPrerelease\b/g, replacement: 'state.forms.release.isPrerelease' },
  { pattern: /\bnewThreadTitle\b/g, replacement: 'state.forms.discussion.threadTitle' },
  { pattern: /\bnewThreadContent\b/g, replacement: 'state.forms.discussion.threadContent' },
  { pattern: /\breplyContent\b/g, replacement: 'state.forms.discussion.replyContent' },
  { pattern: /\bselectedPatchText\b/g, replacement: 'state.forms.patchHighlight.text' },
  { pattern: /\bselectedPatchStartLine\b/g, replacement: 'state.forms.patchHighlight.startLine' },
  { pattern: /\bselectedPatchEndLine\b/g, replacement: 'state.forms.patchHighlight.endLine' },
  { pattern: /\bselectedPatchStartPos\b/g, replacement: 'state.forms.patchHighlight.startPos' },
  { pattern: /\bselectedPatchEndPos\b/g, replacement: 'state.forms.patchHighlight.endPos' },
  { pattern: /\bpatchHighlightComment\b/g, replacement: 'state.forms.patchHighlight.comment' },
  { pattern: /\bpatchCommentContent\b/g, replacement: 'state.forms.patchComment.content' },
  { pattern: /\breplyingToPatchComment\b/g, replacement: 'state.forms.patchComment.replyingTo' },
  
  // Dialogs
  { pattern: /\bshowCreateFileDialog\b/g, replacement: "state.openDialog === 'createFile'" },
  { pattern: /\bshowCreateBranchDialog\b/g, replacement: "state.openDialog === 'createBranch'" },
  { pattern: /\bshowCreateTagDialog\b/g, replacement: "state.openDialog === 'createTag'" },
  { pattern: /\bshowCommitDialog\b/g, replacement: "state.openDialog === 'commit'" },
  { pattern: /\bshowCreateIssueDialog\b/g, replacement: "state.openDialog === 'createIssue'" },
  { pattern: /\bshowCreatePRDialog\b/g, replacement: "state.openDialog === 'createPR'" },
  { pattern: /\bshowCreatePatchDialog\b/g, replacement: "state.openDialog === 'createPatch'" },
  { pattern: /\bshowCreateReleaseDialog\b/g, replacement: "state.openDialog === 'createRelease'" },
  { pattern: /\bshowCreateThreadDialog\b/g, replacement: "state.openDialog === 'createThread'" },
  { pattern: /\bshowReplyDialog\b/g, replacement: "state.openDialog === 'reply'" },
  { pattern: /\bshowVerificationDialog\b/g, replacement: "state.openDialog === 'verification'" },
  { pattern: /\bshowCloneUrlVerificationDialog\b/g, replacement: "state.openDialog === 'cloneUrlVerification'" },
  { pattern: /\bshowPatchHighlightDialog\b/g, replacement: "state.openDialog === 'patchHighlight'" },
  { pattern: /\bshowPatchCommentDialog\b/g, replacement: "state.openDialog === 'patchComment'" },
  
  // Selected items
  { pattern: /\bselectedIssue\b/g, replacement: 'state.selected.issue' },
  { pattern: /\bselectedPR\b/g, replacement: 'state.selected.pr' },
  { pattern: /\bselectedPatch\b/g, replacement: 'state.selected.patch' },
  { pattern: /\bselectedDiscussion\b/g, replacement: 'state.selected.discussion' },
  
  // Creating flags
  { pattern: /\bcreatingPatch\b/g, replacement: 'state.creating.patch' },
  { pattern: /\bcreatingThread\b/g, replacement: 'state.creating.thread' },
  { pattern: /\bcreatingReply\b/g, replacement: 'state.creating.reply' },
  { pattern: /\bcreatingRelease\b/g, replacement: 'state.creating.release' },
  { pattern: /\bcreatingPatchHighlight\b/g, replacement: 'state.creating.patchHighlight' },
  { pattern: /\bcreatingPatchComment\b/g, replacement: 'state.creating.patchComment' },
  { pattern: /\bdeletingAnnouncement\b/g, replacement: 'state.creating.announcement' },
  
  // Maintainers
  { pattern: /\bisMaintainer\b/g, replacement: 'state.maintainers.isMaintainer' },
  { pattern: /\ballMaintainers\b/g, replacement: 'state.maintainers.all' },
  { pattern: /\bmaintainersLoaded\b/g, replacement: 'state.maintainers.loaded' },
  { pattern: /\bmaintainersEffectRan\b/g, replacement: 'state.maintainers.effectRan' },
  { pattern: /\blastRepoKey\b/g, replacement: 'state.maintainers.lastRepoKey' },
  
  // Clone
  { pattern: /\bisRepoCloned\b/g, replacement: 'state.clone.isCloned' },
  { pattern: /\bcheckingCloneStatus\b/g, replacement: 'state.clone.checking' },
  { pattern: /\bcloning\b/g, replacement: 'state.clone.cloning' },
  { pattern: /\bcopyingCloneUrl\b/g, replacement: 'state.clone.copyingUrl' },
  { pattern: /\bapiFallbackAvailable\b/g, replacement: 'state.clone.apiFallbackAvailable' },
  { pattern: /\bcloneUrlsExpanded\b/g, replacement: 'state.clone.urlsExpanded' },
  { pattern: /\bshowAllCloneUrls\b/g, replacement: 'state.clone.showAllUrls' },
  { pattern: /\bcloneUrlReachability\b/g, replacement: 'state.clone.reachability' },
  { pattern: /\bcheckingReachability\b/g, replacement: 'state.clone.checkingReachability' },
  
  // Verification
  { pattern: /\bverificationStatus\b/g, replacement: 'state.verification.status' },
  { pattern: /\bverificationFileContent\b/g, replacement: 'state.verification.fileContent' },
  { pattern: /\bverifyingCloneUrl\b/g, replacement: 'state.verification.selectedCloneUrl' },
  { pattern: /\bselectedCloneUrlForVerification\b/g, replacement: 'state.verification.selectedCloneUrl' },
  
  // Docs
  { pattern: /\bdocumentationContent\b/g, replacement: 'state.docs.content' },
  { pattern: /\bdocumentationHtml\b/g, replacement: 'state.docs.html' },
  { pattern: /\bdocumentationKind\b/g, replacement: 'state.docs.kind' },
  
  // Code search
  { pattern: /\bcodeSearchQuery\b/g, replacement: 'state.codeSearch.query' },
  { pattern: /\bcodeSearchResults\b/g, replacement: 'state.codeSearch.results' },
  { pattern: /\bcodeSearchScope\b/g, replacement: 'state.codeSearch.scope' },
  
  // Fork/Bookmark
  { pattern: /\bforkInfo\b/g, replacement: 'state.fork.info' },
  { pattern: /\bforking\b/g, replacement: 'state.fork.forking' },
  { pattern: /\bisBookmarked\b/g, replacement: 'state.bookmark.isBookmarked' },
  
  // Metadata
  { pattern: /\brepoAddress\b/g, replacement: 'state.metadata.address' },
  { pattern: /\brepoImage\b/g, replacement: 'state.metadata.image' },
  { pattern: /\brepoBanner\b/g, replacement: 'state.metadata.banner' },
  { pattern: /\brepoOwnerPubkeyState\b/g, replacement: 'state.metadata.ownerPubkey' },
  { pattern: /\breadmeAutoLoadAttempted\b/g, replacement: 'state.metadata.readmeAutoLoadAttempted' },
  
  // Discussion
  { pattern: /\breplyingToThread\b/g, replacement: 'state.discussion.replyingToThread' },
  { pattern: /\breplyingToComment\b/g, replacement: 'state.discussion.replyingToComment' },
  { pattern: /\bdiscussionEvents\b/g, replacement: 'state.discussion.events' },
  { pattern: /\bnostrLinkEvents\b/g, replacement: 'state.discussion.nostrLinkEvents' },
  { pattern: /\bnostrLinkProfiles\b/g, replacement: 'state.discussion.nostrLinkProfiles' },
  
  // Other
  { pattern: /\bpatchEditor\b/g, replacement: 'state.patchEditor' },
  { pattern: /\bsaving\b/g, replacement: 'state.saving' },
  { pattern: /\bisMounted\b/g, replacement: 'state.isMounted' },
  { pattern: /\brepoNotFound\b/g, replacement: 'state.repoNotFound' },
  { pattern: /\berror\b/g, replacement: 'state.error' },
  
  // Status updates
  { pattern: /\bupdatingIssueStatus\b/g, replacement: 'state.statusUpdates.issue' },
  { pattern: /\bupdatingPatchStatus\b/g, replacement: 'state.statusUpdates.patch' },
  
  // Data collections (keep as-is but ensure they're accessed via state)
  { pattern: /\bissues\b/g, replacement: 'state.issues' },
  { pattern: /\bissueReplies\b/g, replacement: 'state.issueReplies' },
  { pattern: /\bprs\b/g, replacement: 'state.prs' },
  { pattern: /\bpatches\b/g, replacement: 'state.patches' },
  { pattern: /\bpatchHighlights\b/g, replacement: 'state.patchHighlights' },
  { pattern: /\bpatchComments\b/g, replacement: 'state.patchComments' },
  { pattern: /\bdiscussions\b/g, replacement: 'state.discussions' },
  { pattern: /\breleases\b/g, replacement: 'state.releases' },
];

// Special cases that need context-aware replacement
const contextAwareReplacements = [
  // Dialog assignments
  { 
    pattern: /(showCreateFileDialog|showCreateBranchDialog|showCreateTagDialog|showCommitDialog|showCreateIssueDialog|showCreatePRDialog|showCreatePatchDialog|showCreateReleaseDialog|showCreateThreadDialog|showReplyDialog|showVerificationDialog|showCloneUrlVerificationDialog|showPatchHighlightDialog|showPatchCommentDialog)\s*=\s*(true|false)/g,
    replacement: (match, varName, value) => {
      const dialogMap = {
        showCreateFileDialog: 'createFile',
        showCreateBranchDialog: 'createBranch',
        showCreateTagDialog: 'createTag',
        showCommitDialog: 'commit',
        showCreateIssueDialog: 'createIssue',
        showCreatePRDialog: 'createPR',
        showCreatePatchDialog: 'createPatch',
        showCreateReleaseDialog: 'createRelease',
        showCreateThreadDialog: 'createThread',
        showReplyDialog: 'reply',
        showVerificationDialog: 'verification',
        showCloneUrlVerificationDialog: 'cloneUrlVerification',
        showPatchHighlightDialog: 'patchHighlight',
        showPatchCommentDialog: 'patchComment'
      };
      const dialogType = dialogMap[varName];
      return value === 'true' ? `state.openDialog = '${dialogType}'` : `state.openDialog = null`;
    }
  }
];

function migrateFile(content) {
  let migrated = content;
  
  // Apply simple replacements
  for (const { pattern, replacement } of migrations) {
    migrated = migrated.replace(pattern, replacement);
  }
  
  // Apply context-aware replacements
  for (const { pattern, replacement } of contextAwareReplacements) {
    if (typeof replacement === 'function') {
      migrated = migrated.replace(pattern, replacement);
    } else {
      migrated = migrated.replace(pattern, replacement);
    }
  }
  
  return migrated;
}

// Read file
console.log(`Reading ${targetFile}...`);
let content = readFileSync(targetFile, 'utf-8');

// Backup original
const backupFile = targetFile + '.backup';
writeFileSync(backupFile, content, 'utf-8');
console.log(`Backup created: ${backupFile}`);

// Migrate
console.log('Applying migrations...');
const migrated = migrateFile(content);

// Write migrated file
writeFileSync(targetFile, migrated, 'utf-8');
console.log(`Migration complete!`);
console.log(`\n⚠️  Please review the changes carefully.`);
console.log(`   Some replacements may need manual adjustment.`);
console.log(`   Backup saved to: ${backupFile}`);
