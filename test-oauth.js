import { openaiCodexOAuthProvider } from "@mariozechner/pi-ai/oauth";

async function run() {
    try {
        const flow = await openaiCodexOAuthProvider.createAuthorizationFlow();
        console.log("FLOW URL:", flow.url);
    } catch (e) {
        console.error(e);
    }
}
run();
