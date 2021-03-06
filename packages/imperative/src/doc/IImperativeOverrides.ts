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

import {ICredentialManagerConstructor} from "../../../security";

/**
 * All of the Default Imperative classes that can be changed by your Imperative CLI app
 */
export interface IImperativeOverrides {
  /**
   * A class that your Imperative CLI app can provide us in place of our
   * {@link DefaultCredentialManager}, so that you can meet your security
   * requirements. The provided class must extend Imperative's
   * {@link AbstractCredentialManager}
   *
   * There are 2 ways that you can specify your credential manager to us:
   * 1. If you are within any code statements, you can directly provide a class that adheres to the
   *    {@link ICredentialManagerConstructor}
   *    - {@link IImperativeConfig.configurationModule}
   *    - {@link Imperative.init}
   * 2. You can also provide a string specifying the location of a module to load.
   *
   * ### Directly Providing a Class (Way #1)
   *
   * This method is fairly straight forward as all that you need to do is provide the class name
   * of a class that adheres to the {@link ICredentialManagerConstructor}.
   *
   * ### Specifying the Location of a Class Module (Way #2)
   *
   * This method is a bit more complicated compared to Way #1, but it allows for your package.json to
   * contain all of your necessary config. The string parameter can either be an absolute path (for
   * those cases where you want to have a bit more control by using `__dirname`) or a relative path.
   *
   * In the case that the string is a relative path, it __MUST__ be a path relative to the entry
   * point of your CLI.
   *
   * For example:
   *
   * __Assume__
   *  - `/` is the root of your project
   *  - `/lib/index.js` is the compiled entry point of your project.
   *  - `/lib/overrides/OverrideCredentialManager.js` is the compiled location of your credential manager
   *
   * __Then__
   *  - `IImperativeOverrides.CredentialManager = "./overrides/OverrideCredentialManager";`
   *
   * #### Expected Format of Module File
   *
   * Imperative will expect that the file specified in the location string exports a class that extends
   * the {@link AbstractCredentialManager}. This can be done in TypeScript in one of the following ways:
   *
   * _Exporting an Anonymous Class_
   * ```TypeScript
   * export = class extends AbstractCredentialManager {
   *   // Code goes here
   * };
   * ```
   *
   * _Exporting a Named Class_
   * ```TypeScript
   * export = class CredentialManager extends AbstractCredentialManager {
   *   // Code goes here
   * };
   * ```
   *
   * _Using `module.exports` (Not preferred for TypeScript Users)_
   * ```TypeScript
   * class CredentialManager extends AbstractCredentialManager {
   *   // Code goes here
   * }
   *
   * module.exports = CredentialManager;
   * ```
   */
  CredentialManager?: ICredentialManagerConstructor | string;
}
