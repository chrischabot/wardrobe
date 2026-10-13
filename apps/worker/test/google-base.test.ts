import { describe, expect, it } from "vitest";
import { googleApiBase, googleAuthorizeUrl, googleRevokeUrl, googleTokenUrl } from "../src/connections/service.ts";
import { calendarBaseUrl } from "../src/lanes/daily.ts";

/*
 * The Google fixture addresses (`GOOGLE_API_BASE_URL` and the OAuth endpoint overrides) are honoured only
 * in a local run or a test. A deployment that carries those variables by mistake still sends the owner's
 * Google sign-in, token exchange, revocation and API requests to Google's own hosts, never to the address
 * a variable names.
 */
describe("the Google API and OAuth addresses are overridable only locally", () => {
  const fixture = "https://google.fixture.test/";
  const authUrl = "https://google.fixture.test/authorize";
  const tokenUrl = "https://google.fixture.test/token";
  const revokeUrl = "https://google.fixture.test/revoke";

  it("uses the fixture addresses in a test or local run", () => {
    const env = { GOOGLE_API_BASE_URL: fixture, GOOGLE_OAUTH_AUTHORIZE_URL: authUrl, GOOGLE_OAUTH_TOKEN_URL: tokenUrl, GOOGLE_OAUTH_REVOKE_URL: revokeUrl, ENVIRONMENT: "test" } as never;
    expect(googleApiBase(env)).toBe("https://google.fixture.test");
    expect(calendarBaseUrl(env)).toBe("https://google.fixture.test/calendar/v3");
    expect(googleAuthorizeUrl(env)).toBe(authUrl);
    expect(googleTokenUrl(env)).toBe(tokenUrl);
    expect(googleRevokeUrl(env)).toBe(revokeUrl);
  });

  it("ignores them in a deployed environment and reaches Google itself", () => {
    for (const ENVIRONMENT of ["development", "production", "staging", undefined]) {
      const env = { GOOGLE_API_BASE_URL: fixture, GOOGLE_OAUTH_AUTHORIZE_URL: authUrl, GOOGLE_OAUTH_TOKEN_URL: tokenUrl, GOOGLE_OAUTH_REVOKE_URL: revokeUrl, ENVIRONMENT } as never;
      expect(googleApiBase(env), String(ENVIRONMENT)).toBe("https://www.googleapis.com");
      expect(calendarBaseUrl(env), String(ENVIRONMENT)).toBeUndefined();
      expect(googleAuthorizeUrl(env), String(ENVIRONMENT)).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(googleTokenUrl(env), String(ENVIRONMENT)).toBe("https://oauth2.googleapis.com/token");
      expect(googleRevokeUrl(env), String(ENVIRONMENT)).toBe("https://oauth2.googleapis.com/revoke");
    }
    expect(googleApiBase({ ENVIRONMENT: "test" } as never)).toBe("https://www.googleapis.com");
  });
});
