import { isAppRole, type AppRole } from '@cloudpunch/shared';

/**
 * Microsoft Graph, with the signed-in admin's delegated token
 * (ADR-0020). Only what People needs: find someone in the directory,
 * and list / add / remove their role on the CloudPunch API.
 */

export interface DirectoryUser {
  oid: string;
  name: string;
  email: string | null;
  givenName: string | null;
  surname: string | null;
}

export interface RoleAssignment {
  /** Graph's id for the assignment (to remove it). */
  id: string;
  oid: string;
  name: string;
  role: AppRole;
}

export interface Graph {
  searchUsers(query: string): Promise<DirectoryUser[]>;
  getUser(oid: string): Promise<DirectoryUser | null>;
  listAssignments(): Promise<RoleAssignment[]>;
  assign(oid: string, role: AppRole): Promise<void>;
  unassign(assignmentId: string): Promise<void>;
}

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

interface GraphUser {
  id: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

function toUser(u: GraphUser): DirectoryUser {
  return {
    oid: u.id,
    name: u.displayName ?? u.userPrincipalName ?? u.id,
    email: u.mail ?? u.userPrincipalName ?? null,
    givenName: u.givenName ?? null,
    surname: u.surname ?? null,
  };
}

/** A Graph client for one request, on the CloudPunch API's service principal. */
export function createGraph(opts: {
  token: string;
  /** The CloudPunch API app registration's client id (appId). */
  apiAppId: string;
  fetch?: typeof fetch;
  base?: string;
}): Graph {
  const base = opts.base ?? 'https://graph.microsoft.com/v1.0';
  const doFetch = opts.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown, headers = {}): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { code?: string; message?: string };
    };
    if (!res.ok) {
      throw new GraphError(
        res.status,
        json.error?.code ?? `http_${res.status}`,
        json.error?.message ?? `Graph ${method} ${path} failed`,
      );
    }
    return json;
  }

  let sp: Promise<{ id: string; roles: Map<string, AppRole> }> | null = null;
  /** The service principal and its role id → value map (cached per request). */
  const servicePrincipal = () =>
    (sp ??= call<{ id: string; appRoles: { id: string; value: string | null }[] }>(
      'GET',
      `/servicePrincipals(appId='${encodeURIComponent(opts.apiAppId)}')?$select=id,appRoles`,
    ).then((s) => {
      const roles = new Map<string, AppRole>();
      for (const r of s.appRoles) if (isAppRole(r.value)) roles.set(r.id, r.value);
      return { id: s.id, roles };
    }));

  return {
    async searchUsers(query) {
      // Graph $search needs quotes; strip ours out of the text.
      const q = query.replace(/["\\]/g, ' ').trim();
      if (q.length < 2) return [];
      const search = encodeURIComponent(`"displayName:${q}" OR "mail:${q}"`);
      const r = await call<{ value: GraphUser[] }>(
        'GET',
        `/users?$search=${search}&$select=id,displayName,givenName,surname,mail,userPrincipalName&$top=15`,
        undefined,
        { ConsistencyLevel: 'eventual' },
      );
      return r.value.map(toUser);
    },

    async getUser(oid) {
      try {
        const u = await call<GraphUser>(
          'GET',
          `/users/${encodeURIComponent(oid)}?$select=id,displayName,givenName,surname,mail,userPrincipalName`,
        );
        return toUser(u);
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) return null;
        throw err;
      }
    },

    async listAssignments() {
      const s = await servicePrincipal();
      const out: RoleAssignment[] = [];
      let next: string | null = `/servicePrincipals/${s.id}/appRoleAssignedTo?$top=999`;
      while (next) {
        const page: {
          value: {
            id: string;
            principalId: string;
            principalType: string;
            principalDisplayName: string | null;
            appRoleId: string;
          }[];
          '@odata.nextLink'?: string;
        } = await call('GET', next);
        for (const a of page.value) {
          const role = s.roles.get(a.appRoleId);
          if (a.principalType === 'User' && role) {
            out.push({ id: a.id, oid: a.principalId, name: a.principalDisplayName ?? '', role });
          }
        }
        next = page['@odata.nextLink']?.replace(base, '') ?? null;
      }
      return out;
    },

    async assign(oid, role) {
      const s = await servicePrincipal();
      const appRoleId = [...s.roles].find(([, v]) => v === role)?.[0];
      if (!appRoleId) throw new GraphError(400, 'unknown_role', `role ${role} is not on the app`);
      await call('POST', `/servicePrincipals/${s.id}/appRoleAssignedTo`, {
        principalId: oid,
        resourceId: s.id,
        appRoleId,
      });
    },

    async unassign(assignmentId) {
      const s = await servicePrincipal();
      await call(
        'DELETE',
        `/servicePrincipals/${s.id}/appRoleAssignedTo/${encodeURIComponent(assignmentId)}`,
      );
    },
  };
}
