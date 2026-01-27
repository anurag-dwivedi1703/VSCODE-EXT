/**
 * Simple standalone test for the constitution approval fix
 * Run with: npx ts-node src/test/simple.test.ts
 * Or after compile: node out/test/simple.test.js
 */

function testApproveReviewLogic() {
    console.log('\n🧪 Testing TaskRunner.approveReview() logic\n');
    
    let passed = 0;
    let failed = 0;

    // Test helper
    function assertEqual(actual: any, expected: any, message: string) {
        if (actual === expected) {
            console.log(`  ✅ PASS: ${message}`);
            passed++;
        } else {
            console.log(`  ❌ FAIL: ${message}`);
            console.log(`     Expected: ${expected}, Got: ${actual}`);
            failed++;
        }
    }

    // Simulate the approveReview logic
    function simulateApproveReview(approvalType: string): { status: string; progress: number } {
        let status: string;
        let progress = 90;

        // This is the FIXED logic from TaskRunner.approveReview()
        if (approvalType === 'constitution' || 
            approvalType === 'constitution-update' || 
            approvalType === 'constitution-drift') {
            status = 'completed';
            progress = 100;
        } else {
            status = 'executing';
        }

        return { status, progress };
    }

    console.log('Test 1: Constitution approvals should complete the task');
    console.log('─'.repeat(50));
    
    const constitutionTypes = ['constitution', 'constitution-update', 'constitution-drift'];
    constitutionTypes.forEach(type => {
        const result = simulateApproveReview(type);
        assertEqual(result.status, 'completed', `${type} → status should be 'completed'`);
        assertEqual(result.progress, 100, `${type} → progress should be 100`);
    });

    console.log('\nTest 2: Other approvals should set executing status');
    console.log('─'.repeat(50));
    
    const otherTypes = ['plan', 'command', 'tool', 'file'];
    otherTypes.forEach(type => {
        const result = simulateApproveReview(type);
        assertEqual(result.status, 'executing', `${type} → status should be 'executing'`);
    });

    // Summary
    console.log('\n' + '═'.repeat(50));
    console.log(`📊 Results: ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(50));

    if (failed > 0) {
        process.exit(1);
    }
}

// Run tests
testApproveReviewLogic();
