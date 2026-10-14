const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3000/api/chat';
const SESSION_ID = 'audit-session-123';

async function chat(message, history = []) {
    try {
        const res = await axios.post(API_URL, {
            message,
            history,
            sessionId: SESSION_ID
        });
        return res.data;
    } catch (e) {
        console.error('API Error:', e.message);
        return null;
    }
}

async function runAudit() {
    console.log('--- Starting Audit ---\n');
    let history = [];

    // 1. Menu Accuracy & Basic Addition
    console.log('Testing Menu Accuracy...');
    let res = await chat('I want a Latte', history);
    if (res && res.reply.includes('added a Latte')) {
        console.log('✅ Menu item addition: Passed');
    } else {
        console.log('❌ Menu item addition: Failed');
    }
    history = res.history;

    // 2. Item Modifications (Quantity)
    console.log('Testing Quantity Modification...');
    res = await chat('Change Latte to 2', history);
    if (res && res.orderState.items[0].quantity === 2) {
        console.log('✅ Quantity modification: Passed');
    } else {
        console.log('❌ Quantity modification: Failed');
    }
    history = res.history;

    // 3. Item Modifications (Options)
    console.log('Testing Options Addition...');
    res = await chat('Add oat milk to my Latte', history);
    if (res && res.orderState.items[0].options.includes('oat milk')) {
        console.log('✅ Options addition: Passed');
    } else {
        console.log('❌ Options addition: Failed');
    }
    history = res.history;

    // 4. Delivery Flow & Missing Info
    console.log('Testing Delivery Flow...');
    res = await chat('checkout', history);
    res = await chat('delivery', res.history);
    res = await chat('John Doe', res.history); // Name
    res = await chat('1234567890', res.history); // Phone
    res = await chat('123 Main St', res.history); // Address
    res = await chat('Apt 4B', res.history); // Unit
    res = await chat('Leave at door', res.// Instructions
    // Wait, I'm writing this in a bash block, let me fix the script logic.
