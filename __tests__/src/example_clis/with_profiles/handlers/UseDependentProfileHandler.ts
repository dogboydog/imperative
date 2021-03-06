/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

import {ICommandHandler, IHandlerParameters} from "../../../../../packages/cmd";

export default class UseDependentProfile implements ICommandHandler {
    public async process(params: IHandlerParameters) {
        const dependencyProfile = params.profiles.get("profile-a");
        params.response.console.log("Loaded profile dependency {{name}} of type {{type}}",
            {name: dependencyProfile.name, type: dependencyProfile.type});
        const mainProfile = params.profiles.get("profile-with-dependency");
        params.response.console.log("Loaded main profile {{name}} of type {{type}}",
            {name: mainProfile.name, type: mainProfile.type});
    }
}
